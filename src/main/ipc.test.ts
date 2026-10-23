import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { IPC, MAX_MESSAGE_LIMIT } from '../shared/ipc'
import { registerSessionIpc } from './ipc'
import { createSessionController } from './session-controller'
import { testService, testSession, testSystem } from './test-support'

const key = testSession().key
const requests: [string, unknown[]][] = [
  [IPC.getTheme, []],
  [IPC.setTheme, ['dark']],
  [IPC.getSnapshot, []],
  [IPC.getMessages, [key, 20]],
  [IPC.setPinned, [key, true]],
  [IPC.markRead, [key]],
  [IPC.openTool, ['codex']],
  [IPC.copySessionId, [key]],
  [IPC.openLink, ['https://example.com/path?q=1']],
  [IPC.reload, []],
  [IPC.setSelection, [key]],
  [IPC.setSelection, [key, { secondPaneOpen: true }]],
  [IPC.setSelection, [null, { secondPaneOpen: true }]],
  [IPC.setDetailOpen, [true]],
  [IPC.showSessionMenu, [key]]
]

function setup() {
  const service = testService()
  const system = testSystem()
  const frame = { url: 'file:///synthetic/index.html' }
  const contents = { mainFrame: frame, isDestroyed: vi.fn(() => false) }
  const event = { sender: contents, senderFrame: frame }
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>()
  const ipc = {
    handle: vi.fn<IpcMain['handle']>((channel, handler) => {
      handlers.set(channel, handler)
    }),
    removeHandler: vi.fn<IpcMain['removeHandler']>()
  }
  const options = {
    service,
    system,
    fixtureHome: '/synthetic/home',
    reload: service.reconcile,
    command: vi.fn(),
    updateMenu: vi.fn(),
    popup: vi.fn()
  }
  const controller = createSessionController(options)
  const preferences = {
    getTheme: vi.fn().mockResolvedValue('system'),
    setTheme: vi.fn().mockResolvedValue(undefined),
    flush: vi.fn().mockResolvedValue(undefined)
  }
  const dispose = registerSessionIpc({
    ipc,
    contents: contents as unknown as WebContents,
    pageUrl: frame.url,
    controller,
    preferences
  })
  async function invoke(channel: string, args: unknown[], sender = event) {
    const handler = handlers.get(channel)
    if (!handler) throw new Error('Missing handler')
    return await handler(sender as unknown as IpcMainInvokeEvent, ...args)
  }
  function expectNoEffects() {
    for (const fn of [
      service.snapshot,
      service.recentMessages,
      service.setPinned,
      service.markRead,
      service.reconcile,
      system.openTool,
      system.copyText,
      system.openLink,
      options.popup,
      options.updateMenu,
      preferences.getTheme,
      preferences.setTheme
    ])
      expect(fn).not.toHaveBeenCalled()
  }
  return {
    ...options,
    event,
    contents,
    frame,
    handlers,
    invoke,
    dispose,
    ipc,
    controller,
    preferences,
    expectNoEffects
  }
}

describe('IPC trust boundary', () => {
  it.each([null, true, {}, [], 'Dark', 'auto', '../preferences.json', 1])(
    'rejects invalid theme values without effects: %j',
    async (theme) => {
      const s = setup()
      await expect(s.invoke(IPC.setTheme, [theme])).rejects.toThrow('Invalid AgentPeek request')
      s.expectNoEffects()
    }
  )
  it('accepts exactly the three appearance choices and sanitizes preference errors', async () => {
    const s = setup()
    for (const theme of ['system', 'light', 'dark']) await s.invoke(IPC.setTheme, [theme])
    expect(s.preferences.setTheme.mock.calls).toEqual([['system'], ['light'], ['dark']])
    s.preferences.setTheme.mockRejectedValue(new Error('Synthetic private filesystem path'))
    await expect(s.invoke(IPC.setTheme, ['dark'])).rejects.toThrow(
      'AgentPeek could not complete the request.'
    )
  })
  it.each([
    undefined,
    null,
    true,
    [],
    {},
    { secondPaneOpen: 1 },
    { secondPaneOpen: true, extra: false },
    { secondPaneOpen: false, path: '/synthetic' }
  ])('rejects malformed presentation metadata before any action: %j', async (metadata) => {
    const s = setup()
    await expect(s.invoke(IPC.setSelection, [key, metadata])).rejects.toThrow(
      'Invalid AgentPeek request'
    )
    s.expectNoEffects()
  })
  it.each(requests)('accepts the own page and valid arguments: %s', async (channel, args) => {
    const { invoke } = setup()
    await expect(invoke(channel, args)).resolves.not.toThrow()
  })
  it.each(requests)(
    'rejects a foreign renderer even with the same URL: %s',
    async (channel, args) => {
      const s = setup()
      await expect(
        s.invoke(channel, args, { ...s.event, sender: {} as typeof s.contents })
      ).rejects.toThrow('Invalid AgentPeek request')
      s.expectNoEffects()
    }
  )
  it.each(requests)('rejects a child frame at the same URL: %s', async (channel, args) => {
    const s = setup()
    await expect(
      s.invoke(channel, args, { ...s.event, senderFrame: { ...s.frame } })
    ).rejects.toThrow('Invalid AgentPeek request')
    s.expectNoEffects()
  })
  it('rejects a changed URL, missing frame, and destroyed contents', async () => {
    for (const mode of ['url', 'frame', 'destroyed']) {
      const s = setup()
      if (mode === 'url') s.frame.url = 'file:///synthetic/index.html.evil'
      if (mode === 'frame') s.event.senderFrame = null as never
      if (mode === 'destroyed') s.contents.isDestroyed.mockReturnValue(true)
      await expect(s.invoke(IPC.getSnapshot, [])).rejects.toThrow('Invalid AgentPeek request')
      s.expectNoEffects()
    }
  })
  it.each(requests)('rejects extra arguments for every handler: %s', async (channel, args) => {
    const s = setup()
    await expect(s.invoke(channel, [...args, 'unexpected', 'extra'])).rejects.toThrow(
      'Invalid AgentPeek request'
    )
    s.expectNoEffects()
  })
  it.each([
    null,
    {},
    { tool: 'other', id: 'synthetic' },
    { tool: 'codex', id: '' },
    { tool: 'codex', id: 1 },
    { tool: 'codex', id: 'x'.repeat(4097) },
    { tool: 'codex', id: 'synthetic\n' },
    { ...key, path: '/not-allowed' }
  ])('rejects an invalid key without reading or performing actions: %j', async (value) => {
    const s = setup()
    for (const channel of [IPC.markRead, IPC.copySessionId, IPC.showSessionMenu])
      await expect(s.invoke(channel, [value])).rejects.toThrow('Invalid AgentPeek request')
    await expect(s.invoke(IPC.getMessages, [value, 20])).rejects.toThrow(
      'Invalid AgentPeek request'
    )
    await expect(s.invoke(IPC.setPinned, [value, true])).rejects.toThrow(
      'Invalid AgentPeek request'
    )
    if (value !== null)
      await expect(s.invoke(IPC.setSelection, [value])).rejects.toThrow('Invalid AgentPeek request')
    s.expectNoEffects()
  })
  it.each([0, -1, 1.5, NaN, Infinity, MAX_MESSAGE_LIMIT + 1, '20', null])(
    'rejects an invalid message limit: %s',
    async (limit) => {
      const s = setup()
      await expect(s.invoke(IPC.getMessages, [key, limit])).rejects.toThrow(
        'Invalid AgentPeek request'
      )
      s.expectNoEffects()
    }
  )
  it.each([
    'file:///tmp/test',
    'javascript:alert(1)',
    'codex://synthetic',
    'ftp://example.com',
    'https://user:password@example.com',
    ' https://example.com',
    'https://example.com\n',
    'not a URL',
    null
  ])('rejects unsafe links before reaching the system: %s', async (url) => {
    const s = setup()
    await expect(s.invoke(IPC.openLink, [url])).rejects.toThrow('Invalid AgentPeek request')
    s.expectNoEffects()
  })
  it('validates the remaining argument types and accepts the message-limit boundaries', async () => {
    const s = setup()
    await expect(s.invoke(IPC.openTool, ['arbitrary.bundle'])).rejects.toThrow()
    await expect(s.invoke(IPC.setPinned, [key, 1])).rejects.toThrow()
    await expect(s.invoke(IPC.setDetailOpen, ['true'])).rejects.toThrow()
    await expect(s.invoke(IPC.markRead, [key, ''])).rejects.toThrow()
    await expect(s.invoke(IPC.markRead, [key, 'x\n'])).rejects.toThrow()
    s.expectNoEffects()
    for (const limit of [1, MAX_MESSAGE_LIMIT]) await s.invoke(IPC.getMessages, [key, limit])
    expect(s.service.recentMessages.mock.calls).toEqual([
      [key, 1],
      [key, MAX_MESSAGE_LIMIT]
    ])
    await s.invoke(IPC.setSelection, [null])
  })
  it('sanitizes failures rather than sending source error text back', async () => {
    const s = setup()
    s.service.recentMessages.mockRejectedValue(new Error('Synthetic text that must stay private'))
    await expect(s.invoke(IPC.getMessages, [key, 20])).rejects.toThrow(
      'AgentPeek could not complete the request.'
    )
  })
  it('removes exactly its own handlers on shutdown', () => {
    const s = setup()
    s.dispose()
    expect(s.ipc.removeHandler.mock.calls.map(([channel]) => channel)).toEqual([
      ...s.handlers.keys()
    ])
  })
})
