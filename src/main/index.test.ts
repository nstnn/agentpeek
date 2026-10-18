import { EventEmitter } from 'node:events'
import type { IpcMain, IpcMainInvokeEvent, MenuItemConstructorOptions } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '../shared/ipc'
import { testService, testSystem } from './test-support'

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
    getContentBounds: vi.fn(() => ({ width: 1100 }))
  })
  const app = Object.assign(new EventEmitter(), {
    enableSandbox: vi.fn(),
    isPackaged: false,
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
    session: {
      defaultSession: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() }
    }
  }))
  vi.doMock('./sessions/open-sessions', () => ({ openSessionsService: open }))
  vi.doMock('./window', () => ({
    createMainWindow: createWindow,
    rendererPageUrl: () => frame.url
  }))
  vi.doMock('./system-actions', () => ({ systemActions: testSystem() }))
  return { app, powerMonitor, service, open, createWindow, window, contents, ipcMain, Menu }
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
  it('keeps Back disabled after selecting a row in the narrow list without a detail screen', async () => {
    const s = setup()
    s.window.getContentBounds.mockReturnValue({ width: 760 })
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
    expect(s.ipcMain.handle).toHaveBeenCalledTimes(10)
    vi.useFakeTimers()
    s.window.emit('focus')
    s.window.emit('focus')
    await vi.advanceTimersByTimeAsync(250)
    expect(s.service.reconcile).toHaveBeenCalledOnce()
    s.powerMonitor.emit('resume')
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
    expect(s.ipcMain.removeHandler).toHaveBeenCalledTimes(10)
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
