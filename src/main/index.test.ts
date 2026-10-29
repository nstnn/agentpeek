import { EventEmitter } from 'node:events'
import type { IpcMain, IpcMainInvokeEvent, MenuItemConstructorOptions } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '../shared/ipc'
import { testService, testSystem } from './test-support'
import type { openPreferences, Preferences } from './preferences'

function setup() {
  const frame = { url: 'file:///synthetic/index.html' }
  const contents = Object.assign(new EventEmitter(), {
    mainFrame: frame,
    isDestroyed: vi.fn(() => false),
    getURL: () => frame.url,
    send: vi.fn()
  })
  const window = Object.assign(new EventEmitter(), {
    webContents: contents,
    isMinimized: () => false,
    restore: vi.fn(),
    focus: vi.fn(),
    getContentSize: vi.fn(() => [1100, 720])
  })
  const app = Object.assign(new EventEmitter(), {
    enableSandbox: vi.fn(),
    isPackaged: false,
    getVersion: () => '0.1.0',
    setAboutPanelOptions: vi.fn(),
    getPath: () => '/synthetic/default-state',
    setPath: vi.fn(),
    requestSingleInstanceLock: vi.fn(() => true),
    quit: vi.fn(),
    whenReady: vi.fn(() => Promise.resolve()),
    focus: vi.fn()
  })
  const powerMonitor = new EventEmitter()
  const service = testService()
  const open = vi.fn().mockResolvedValue(service)
  const preferences = {
    getTheme: vi.fn<Preferences['getTheme']>().mockResolvedValue('system'),
    setTheme: vi.fn<Preferences['setTheme']>().mockResolvedValue(undefined),
    getSources: vi.fn<Preferences['getSources']>().mockReturnValue({ codex: true, claude: true }),
    setSourceEnabled: vi.fn<Preferences['setSourceEnabled']>().mockResolvedValue(undefined),
    getZoom: vi.fn<Preferences['getZoom']>().mockReturnValue(100),
    changeZoom: vi.fn<Preferences['changeZoom']>().mockResolvedValue(undefined),
    flush: vi.fn<Preferences['flush']>().mockResolvedValue(undefined)
  }
  const createWindow = vi.fn(() => window)
  const ipcMain = { handle: vi.fn<IpcMain['handle']>(), removeHandler: vi.fn() }
  const Menu = {
    buildFromTemplate: vi.fn<(template: MenuItemConstructorOptions[]) => { popup: () => void }>(
      () => ({ popup: vi.fn() })
    ),
    setApplicationMenu: vi.fn()
  }
  vi.doMock('electron', () => ({
    app,
    powerMonitor,
    ipcMain,
    Menu,
    nativeTheme: { themeSource: 'system' },
    session: {
      defaultSession: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() }
    }
  }))
  vi.doMock('./sessions/open-sessions', () => ({ openSessionsService: open }))
  vi.doMock('./preferences', () => ({
    openPreferences: vi.fn<typeof openPreferences>().mockImplementation((_folder, apply) => {
      apply('system')
      return Promise.resolve(preferences)
    })
  }))
  vi.doMock('./window', () => ({
    createMainWindow: createWindow,
    rendererPageUrl: () => frame.url
  }))
  vi.doMock('./system-actions', () => ({ systemActions: testSystem() }))
  const previewServer = {
    url: 'http://127.0.0.1:1',
    publish: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined)
  }
  const startPreview = vi.fn().mockResolvedValue(previewServer)
  vi.doMock('./remote/preview/preview-server', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    startPreviewServer: startPreview
  }))
  const remoteView = {
    suspend: vi.fn(),
    resume: vi.fn(),
    open: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined)
  }
  const createRemoteView = vi.fn(() => remoteView)
  vi.doMock('./remote/remote-view', () => ({ createRemoteView }))
  return {
    previewServer,
    startPreview,
    remoteView,
    createRemoteView,
    app,
    powerMonitor,
    service,
    open,
    createWindow,
    window,
    contents,
    ipcMain,
    Menu,
    preferences
  }
}

beforeEach(() => {
  vi.resetModules()
  vi.stubEnv('AGENTPEEK_HOME', '/synthetic/home')
  vi.stubEnv('AGENTPEEK_USER_DATA', '/synthetic/state')
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe('main process lifecycle', () => {
  it('waits for an in-flight preference save even if session shutdown fails', async () => {
    const s = setup()
    await import('./index')
    await vi.waitFor(() => expect(s.service.start).toHaveBeenCalledOnce())
    let finish!: () => void
    s.preferences.flush.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve
      })
    )
    s.service.stop.mockRejectedValue(new Error('Synthetic shutdown failure'))
    s.app.emit('before-quit', { preventDefault: vi.fn() })
    await Promise.resolve()
    expect(s.app.quit).not.toHaveBeenCalled()
    finish()
    await vi.waitFor(() => expect(s.app.quit).toHaveBeenCalledOnce())
  })
  it('wires replacement Back at default width and clears split/navigation on renderer navigation', async () => {
    const s = setup()
    await import('./index')
    await vi.waitFor(() => expect(s.service.start).toHaveBeenCalledOnce())
    const invoke = async (channel: string, ...args: unknown[]) => {
      const handler = s.ipcMain.handle.mock.calls.find(([name]) => name === channel)![1]
      await handler(
        { sender: s.contents, senderFrame: s.contents.mainFrame } as unknown as IpcMainInvokeEvent,
        ...args
      )
    }
    const enabled = (id: string) => {
      const items = s.Menu.buildFromTemplate.mock.lastCall![0].find(
        (item) => item.label === 'Session'
      )!.submenu as MenuItemConstructorOptions[]
      return items.find((item) => item.id === id)?.enabled
    }
    await invoke(IPC.setSelection, null, { secondPaneOpen: true })
    await invoke(IPC.setDetailOpen, true)
    expect(enabled('session-back')).toBe(true)
    expect(enabled('session-close-secondary')).toBe(true)
    expect(enabled('session-open-secondary')).toBe(false)
    s.contents.emit('did-start-navigation', {}, '', false, true)
    expect(enabled('session-back')).toBe(false)
    expect(enabled('session-close-secondary')).toBe(false)
  })
  it('keeps Back disabled after selecting a row in the narrow list without a detail screen', async () => {
    const s = setup()
    s.window.getContentSize.mockReturnValue([760, 480])
    await import('./index')
    await vi.waitFor(() => expect(s.service.start).toHaveBeenCalledOnce())
    const select = s.ipcMain.handle.mock.calls.find(
      ([channel]) => channel === IPC.setSelection
    )?.[1]
    if (!select) throw new Error('Selection handler not registered')
    await select(
      { sender: s.contents, senderFrame: s.contents.mainFrame } as unknown as IpcMainInvokeEvent,
      { tool: 'codex', id: 'synthetic-session' }
    )
    const template = s.Menu.buildFromTemplate.mock.lastCall?.[0]
    const items = template?.find((item) => item.label === 'Session')
      ?.submenu as MenuItemConstructorOptions[]
    expect(items.find((item) => item.id === 'session-open')?.enabled).toBe(true)
    expect(items.find((item) => item.id === 'session-back')?.enabled).toBe(false)
  })
  it('sets the fixture profile before the lock, starts once, and wires focus and resume', async () => {
    const s = setup()
    await import('./index')
    await vi.waitFor(() => expect(s.service.start).toHaveBeenCalledOnce())
    expect(s.app.setPath).toHaveBeenCalledWith('userData', '/synthetic/state')
    expect(s.app.setPath.mock.invocationCallOrder[0]).toBeLessThan(
      s.app.requestSingleInstanceLock.mock.invocationCallOrder[0]!
    )
    expect(s.open.mock.calls[0]?.[0]).toMatchObject({
      home: '/synthetic/home',
      stateFolder: '/synthetic/state',
      fixture: true
    })
    expect(s.ipcMain.handle).toHaveBeenCalledTimes(23)
    vi.useFakeTimers()
    s.window.emit('focus')
    s.window.emit('focus')
    await vi.advanceTimersByTimeAsync(250)
    expect(s.service.reconcile).toHaveBeenCalledOnce()
    s.powerMonitor.emit('suspend')
    expect(s.remoteView.suspend).toHaveBeenCalledOnce()
    s.powerMonitor.emit('resume')
    expect(s.remoteView.resume).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(0)
    expect(s.service.reconcile).toHaveBeenCalledTimes(2)
    const { onSnapshot } = s.open.mock.calls[0]?.[0] as { onSnapshot: () => void }
    onSnapshot()
    expect(s.contents.send).toHaveBeenCalledWith(
      IPC.snapshot,
      expect.objectContaining({ fixtureHome: '/synthetic/home' })
    )
  })
  it('waits for stop before quitting, clears handlers and resume/focus timers, and tolerates repeated quit', async () => {
    const s = setup()
    await import('./index')
    await vi.waitFor(() => expect(s.service.start).toHaveBeenCalledOnce())
    let finish!: () => void
    s.service.stop.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve
      })
    )
    vi.useFakeTimers()
    s.window.emit('focus')
    const event = { preventDefault: vi.fn() }
    s.app.emit('before-quit', event)
    s.app.emit('before-quit', event)
    expect(event.preventDefault).toHaveBeenCalledTimes(2)
    expect(s.app.quit).not.toHaveBeenCalled()
    expect(s.service.stop).toHaveBeenCalledOnce()
    expect(s.powerMonitor.listenerCount('resume')).toBe(0)
    expect(s.powerMonitor.listenerCount('suspend')).toBe(0)
    expect(s.ipcMain.removeHandler).toHaveBeenCalledTimes(23)
    expect(vi.getTimerCount()).toBe(0)
    finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(s.app.quit).toHaveBeenCalledOnce()
    const final = { preventDefault: vi.fn() }
    s.app.emit('before-quit', final)
    expect(final.preventDefault).not.toHaveBeenCalled()
  })
  it('stops a service whose store finishes opening after quit, without creating a window or starting it', async () => {
    const s = setup()
    let finish!: (value: typeof s.service) => void
    s.open.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    await import('./index')
    await vi.waitFor(() => expect(s.open).toHaveBeenCalledOnce())
    s.app.emit('before-quit', { preventDefault: vi.fn() })
    finish(s.service)
    await vi.waitFor(() => expect(s.app.quit).toHaveBeenCalledOnce())
    expect(s.service.stop).toHaveBeenCalledOnce()
    expect(s.service.start).not.toHaveBeenCalled()
    expect(s.createWindow).not.toHaveBeenCalled()
  })
  it('does not open a service when another instance holds the lock', async () => {
    const s = setup()
    s.app.requestSingleInstanceLock.mockReturnValue(false)
    await import('./index')
    expect(s.app.quit).toHaveBeenCalledOnce()
    expect(s.open).not.toHaveBeenCalled()
  })
  it('starts no localhost preview without the switch, or with the switch on a real home', async () => {
    const off = setup()
    await import('./index')
    await vi.waitFor(() => expect(off.service.start).toHaveBeenCalledOnce())
    expect(off.startPreview).not.toHaveBeenCalled()

    vi.resetModules()
    vi.stubEnv('AGENTPEEK_HOME', undefined)
    vi.stubEnv('AGENTPEEK_USER_DATA', undefined)
    vi.stubEnv('AGENTPEEK_REMOTE_PREVIEW', '1')
    const real = setup()
    await import('./index')
    await vi.waitFor(() => expect(real.service.start).toHaveBeenCalledOnce())
    expect(real.open.mock.calls[0]?.[0]).toMatchObject({ fixture: false })
    expect(real.startPreview).not.toHaveBeenCalled()
  })
  it('starts the preview on a fixture home with the switch, feeds it snapshots and closes it on quit', async () => {
    vi.stubEnv('AGENTPEEK_REMOTE_PREVIEW', '1')
    const s = setup()
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    await import('./index')
    await vi.waitFor(() => expect(s.service.start).toHaveBeenCalledOnce())
    expect(s.startPreview).toHaveBeenCalledOnce()
    const [options] = s.startPreview.mock.lastCall as [{ snapshot: () => unknown }]
    expect(options.snapshot()).toBe(s.service.snapshot())
    await vi.waitFor(() =>
      expect(out).toHaveBeenCalledWith('AgentPeek localhost preview: http://127.0.0.1:1/\n')
    )
    out.mockRestore()
    const { onSnapshot } = s.open.mock.calls[0]?.[0] as { onSnapshot: (value: unknown) => void }
    const next = s.service.snapshot()
    onSnapshot(next)
    await vi.waitFor(() => expect(s.previewServer.publish).toHaveBeenCalledWith(next))
    s.app.emit('before-quit', { preventDefault: vi.fn() })
    await vi.waitFor(() => expect(s.app.quit).toHaveBeenCalledOnce())
    expect(s.previewServer.close).toHaveBeenCalledOnce()
  })
  it('opens Remote View from the state folder, feeds it snapshots and closes it on quit', async () => {
    const s = setup()
    await import('./index')
    await vi.waitFor(() => expect(s.service.start).toHaveBeenCalledOnce())
    expect(s.createRemoteView).toHaveBeenCalledOnce()
    const [options] = s.createRemoteView.mock.lastCall as unknown as [
      {
        folder: string
        viewerFolder: string
        snapshot: () => unknown
        onChange: (status: unknown) => void
      }
    ]
    // The snapshot is all it gets: never the controller, the service's actions or system actions.
    expect(Object.keys(options).sort()).toEqual(['folder', 'onChange', 'snapshot', 'viewerFolder'])
    expect(options.folder).toBe('/synthetic/state')
    expect(options.viewerFolder).toMatch(/remote-web$/)
    expect(options.snapshot()).toBe(s.service.snapshot())
    expect(s.remoteView.open).toHaveBeenCalledOnce()
    // Each announced status reaches the window on its one fixed channel (TASK-042).
    await vi.waitFor(() => expect(s.ipcMain.handle).toHaveBeenCalled())
    options.onChange({ state: 'loading' })
    expect(s.contents.send).toHaveBeenCalledWith(IPC.remoteStatus, { state: 'loading' })
    const { onSnapshot } = s.open.mock.calls[0]?.[0] as { onSnapshot: (value: unknown) => void }
    const next = s.service.snapshot()
    onSnapshot(next)
    expect(s.remoteView.publish).toHaveBeenCalledWith(next)
    let finish!: () => void
    s.remoteView.close.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve
      })
    )
    s.app.emit('before-quit', { preventDefault: vi.fn() })
    await vi.waitFor(() => expect(s.remoteView.close).toHaveBeenCalledOnce())
    await Promise.resolve()
    expect(s.app.quit).not.toHaveBeenCalled()
    finish()
    await vi.waitFor(() => expect(s.app.quit).toHaveBeenCalledOnce())
  })
  it('quits safely after startup failure without printing the source error', async () => {
    const s = setup()
    s.open.mockRejectedValue(new Error('Synthetic private error'))
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await import('./index')
    await vi.waitFor(() => expect(s.app.quit).toHaveBeenCalledOnce())
    expect(log).not.toHaveBeenCalled()
    log.mockRestore()
  })
})
