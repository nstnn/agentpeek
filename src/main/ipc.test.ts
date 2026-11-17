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
  [IPC.setSourceEnabled, ['codex', false]],
  [IPC.getSnapshot, []],
  [IPC.getMessages, [key, 20]],
  [IPC.getSkill, [key, { at: 1, name: 'pr', path: '/synthetic/.agents/skills/pr/SKILL.md' }]],
  [IPC.setPinned, [key, true]],
  [IPC.markRead, [key]],
  [IPC.openTool, [key]],
  [IPC.copySessionId, [key]],
  [IPC.openLink, ['https://example.com/path?q=1']],
  [IPC.reload, []],
  [IPC.setSelection, [key]],
  [IPC.setSelection, [key, { secondPaneOpen: true }]],
  [IPC.setSelection, [null, { secondPaneOpen: true }]],
  [IPC.setDetailOpen, [true]],
  [IPC.showSessionMenu, [key]],
  [IPC.getRemoteStatus, []],
  [IPC.getRemoteAlias, [key]],
  [IPC.retryRemoteLoad, []],
  [IPC.setRemoteEnabled, [true]],
  [IPC.setRemoteEnabled, [false]],
  [
    IPC.saveRemoteConnection,
    [{ ownerLogin: 'owner@example.com', hostName: 'synthetic-mac.example.ts.net', port: 47613 }]
  ],
  [IPC.setRemoteWorkspaceShared, ['/synthetic/projects/demo', true]],
  [IPC.setRemoteWorkspaceShared, ['/synthetic/projects/demo', false]],
  [IPC.setRemoteShareTitles, [true]],
  [IPC.setRemoteShareMessages, [true]],
  [IPC.setRemoteShareMessages, [false]],
  [IPC.copyRemoteText, ['serve-command']],
  [IPC.copyRemoteText, ['viewer-address']]
]

const SAVED = {
  enabled: false,
  ownerLogin: 'owner@example.com',
  hostName: 'synthetic-mac.example.ts.net',
  port: 47613,
  sharedWorkspaces: [],
  shareTitles: false
}

function testRemote() {
  const ok = () => vi.fn().mockResolvedValue({ ok: true })
  return {
    status: vi.fn(() => ({ state: 'off', settings: { ...SAVED }, startError: null }) as const),
    aliasFor: vi.fn<(key: unknown) => string | null>(() => 'Session 2'),
    retryLoad: vi.fn().mockResolvedValue(undefined),
    enable: ok(),
    disable: ok(),
    saveConnection: ok(),
    shareWorkspace: ok(),
    unshareWorkspace: ok(),
    setShareTitles: ok(),
    // Synchronous in the main process: the value lives in memory only.
    setShareMessages: vi.fn().mockReturnValue({ ok: true })
  }
}

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
    setSourceEnabled: vi.fn().mockResolvedValue(undefined),
    flush: vi.fn().mockResolvedValue(undefined)
  }
  const remote = testRemote()
  const copyText = vi.fn().mockResolvedValue(undefined)
  const dispose = registerSessionIpc({
    ipc,
    contents: contents as unknown as WebContents,
    pageUrl: frame.url,
    controller,
    preferences,
    setSourceEnabled: service.setSourceEnabled,
    remote,
    copyText
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
      service.getSkill,
      service.setPinned,
      service.markRead,
      service.reconcile,
      system.openTool,
      system.copyText,
      system.openLink,
      options.popup,
      options.updateMenu,
      preferences.getTheme,
      preferences.setTheme,
      preferences.setSourceEnabled,
      service.setSourceEnabled,
      ...Object.values(remote),
      copyText
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
    remote,
    copyText,
    expectNoEffects
  }
}

describe('IPC trust boundary', () => {
  it.each([
    {},
    { at: NaN, name: 'pr', path: '/synthetic/.agents/skills/pr/SKILL.md' },
    { at: -1, name: 'pr', path: '/synthetic/.agents/skills/pr/SKILL.md' },
    { at: 1, name: '../pr', path: '/synthetic/.agents/skills/pr/SKILL.md' },
    { at: 1, name: 'pr', path: '/synthetic/.agents/skills/pr/../auth.json' },
    { at: 1, name: 'pr', path: '/synthetic/auth.json' },
    { at: 1, name: 'pr', path: 'file:///synthetic/.agents/skills/pr/SKILL.md' },
    { at: 1, name: 'pr', path: '/synthetic/.agents/skills/pr/SKILL.md', extra: true }
  ])('rejects malformed skill requests before any controller effect: %j', async (request) => {
    const s = setup()
    await expect(s.invoke(IPC.getSkill, [key, request])).rejects.toThrow(
      'Invalid AgentPeek request'
    )
    s.expectNoEffects()
  })
  it('rejects unsupported sources and missing sessions, and sanitizes skill read failures', async () => {
    const s = setup()
    const request = { at: 1, name: 'pr', path: '/synthetic/.agents/skills/pr/SKILL.md' }
    await expect(
      s.invoke(IPC.getSkill, [{ tool: 'other', id: 'synthetic' }, request])
    ).rejects.toThrow('Invalid AgentPeek request')
    await expect(
      s.invoke(IPC.getSkill, [{ tool: 'codex', id: 'missing' }, request])
    ).resolves.toEqual({ kind: 'unavailable', reason: 'not-found' })
    expect(s.service.getSkill).not.toHaveBeenCalled()
    s.service.getSkill.mockRejectedValueOnce(new Error('/synthetic/private-path'))
    await expect(s.invoke(IPC.getSkill, [key, request])).rejects.toThrow(
      'AgentPeek could not complete the request.'
    )
  })
  it('accepts a listed Claude session with the same validated skill request contract', async () => {
    const s = setup()
    const claudeKey = { tool: 'claude' as const, id: 'synthetic-claude' }
    s.service.snapshot.mockReturnValue({
      ...s.service.snapshot(),
      sessions: [testSession({ key: claudeKey })]
    })
    const request = { at: 1, name: 'pr', path: '/synthetic/.claude/skills/pr/SKILL.md' }
    await s.invoke(IPC.getSkill, [claudeKey, request])
    expect(s.service.getSkill).toHaveBeenCalledWith(claudeKey, request)
  })
  it.each([['other', false], ['codex', 'false'], ['claude', null], ['codex'], [null, true]])(
    'rejects malformed source changes: %j',
    async (...args) => {
      const s = setup()
      await expect(s.invoke(IPC.setSourceEnabled, args)).rejects.toThrow(
        'Invalid AgentPeek request'
      )
      s.expectNoEffects()
    }
  )
  it('persists a source choice before applying it and leaves monitoring unchanged after a failed save', async () => {
    const s = setup()
    s.preferences.setSourceEnabled.mockRejectedValueOnce(new Error('synthetic private error'))
    await expect(s.invoke(IPC.setSourceEnabled, ['codex', false])).rejects.toThrow(
      'AgentPeek could not complete the request.'
    )
    expect(s.service.setSourceEnabled).not.toHaveBeenCalled()
    await s.invoke(IPC.setSourceEnabled, ['codex', false])
    expect(s.service.setSourceEnabled).toHaveBeenCalledWith('codex', false)
  })
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
    for (const channel of [IPC.markRead, IPC.openTool, IPC.copySessionId, IPC.showSessionMenu])
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
  it('routes each Remote View action to its one method and returns the typed result', async () => {
    const s = setup()
    await expect(s.invoke(IPC.getRemoteStatus, [])).resolves.toEqual({
      state: 'off',
      settings: SAVED,
      startError: null
    })
    await s.invoke(IPC.setRemoteEnabled, [true])
    await s.invoke(IPC.setRemoteEnabled, [false])
    const connection = { ownerLogin: ' x ', hostName: 'not a name', port: 80 }
    s.remote.saveConnection.mockResolvedValueOnce({
      ok: false,
      error: 'invalid',
      invalid: ['ownerLogin', 'hostName', 'port']
    })
    await expect(s.invoke(IPC.saveRemoteConnection, [connection])).resolves.toEqual({
      ok: false,
      error: 'invalid',
      invalid: ['ownerLogin', 'hostName', 'port']
    })
    await s.invoke(IPC.setRemoteWorkspaceShared, ['/synthetic/a', true])
    await s.invoke(IPC.setRemoteWorkspaceShared, ['/synthetic/b', false])
    s.remote.setShareTitles.mockResolvedValueOnce({ ok: false, error: 'save-failed' })
    await expect(s.invoke(IPC.setRemoteShareTitles, [false])).resolves.toEqual({
      ok: false,
      error: 'save-failed'
    })
    expect(s.remote.enable).toHaveBeenCalledTimes(1)
    expect(s.remote.disable).toHaveBeenCalledTimes(1)
    expect(s.remote.saveConnection.mock.calls).toEqual([[connection]])
    expect(s.remote.shareWorkspace.mock.calls).toEqual([['/synthetic/a']])
    expect(s.remote.unshareWorkspace.mock.calls).toEqual([['/synthetic/b']])
    expect(s.remote.setShareTitles.mock.calls).toEqual([[false]])
    s.remote.setShareMessages.mockReturnValueOnce({ ok: false, error: 'not-listening' })
    await expect(s.invoke(IPC.setRemoteShareMessages, [true])).resolves.toEqual({
      ok: false,
      error: 'not-listening'
    })
    await expect(s.invoke(IPC.setRemoteShareMessages, [false])).resolves.toEqual({ ok: true })
    expect(s.remote.setShareMessages.mock.calls).toEqual([[true], [false]])
  })
  it('copies only text built from the saved settings', async () => {
    const s = setup()
    await expect(s.invoke(IPC.copyRemoteText, ['serve-command'])).resolves.toBe(true)
    await expect(s.invoke(IPC.copyRemoteText, ['viewer-address'])).resolves.toBe(true)
    expect(s.copyText.mock.calls).toEqual([
      ['tailscale serve --bg --https=443 http://127.0.0.1:47613'],
      ['https://synthetic-mac.example.ts.net/']
    ])
    s.copyText.mockClear()
    s.remote.status.mockReturnValue({
      state: 'off',
      settings: { ...SAVED, hostName: '' },
      startError: null
    } as never)
    await expect(s.invoke(IPC.copyRemoteText, ['viewer-address'])).resolves.toBe(false)
    s.remote.status.mockReturnValue({ state: 'load-failed' } as never)
    await expect(s.invoke(IPC.copyRemoteText, ['serve-command'])).resolves.toBe(false)
    expect(s.copyText).not.toHaveBeenCalled()
  })
  it('answers an alias request for exactly the one session asked', async () => {
    const s = setup()
    await expect(s.invoke(IPC.getRemoteAlias, [key])).resolves.toBe('Session 2')
    expect(s.remote.aliasFor.mock.calls).toEqual([[key]])
  })
  it.each([
    [IPC.getRemoteAlias, []],
    [IPC.getRemoteAlias, [{ ...key, extra: 1 }]],
    [IPC.getRemoteAlias, [{ tool: 'other', id: 'x' }]],
    [IPC.getRemoteAlias, [key, key]],
    [IPC.setRemoteEnabled, ['true']],
    [IPC.setRemoteEnabled, []],
    [IPC.setRemoteShareTitles, [1]],
    [IPC.setRemoteShareMessages, ['true']],
    [IPC.setRemoteShareMessages, [1]],
    [IPC.setRemoteShareMessages, []],
    [IPC.setRemoteShareMessages, [true, true]],
    [IPC.saveRemoteConnection, [null]],
    [IPC.saveRemoteConnection, [{ ownerLogin: 'a@b', hostName: 'h.t.ts.net' }]],
    [IPC.saveRemoteConnection, [{ ownerLogin: 'a@b', hostName: 'h.t.ts.net', port: '47613' }]],
    [IPC.saveRemoteConnection, [{ ownerLogin: 1, hostName: 'h.t.ts.net', port: 47613 }]],
    [
      IPC.saveRemoteConnection,
      [{ ownerLogin: 'a@b', hostName: 'h.t.ts.net', port: 47613, enabled: true }]
    ],
    [IPC.saveRemoteConnection, [{ ownerLogin: 'x'.repeat(1025), hostName: '', port: 1 }]],
    [IPC.setRemoteWorkspaceShared, ['relative/path', true]],
    [IPC.setRemoteWorkspaceShared, ['/synthetic/trailing/', true]],
    [IPC.setRemoteWorkspaceShared, ['/', true]],
    [IPC.setRemoteWorkspaceShared, ['/synthetic\n', true]],
    [IPC.setRemoteWorkspaceShared, ['/synthetic', 'true']],
    [IPC.setRemoteWorkspaceShared, ['/synthetic']],
    [IPC.copyRemoteText, ['tailscale funnel 443']],
    [IPC.copyRemoteText, ['/synthetic/remote-view.json']]
  ])('rejects malformed Remote View requests before any effect: %s %j', async (channel, args) => {
    const s = setup()
    await expect(s.invoke(channel, args)).rejects.toThrow('Invalid AgentPeek request')
    s.expectNoEffects()
  })
  it('registers no generic Remote View channel', () => {
    const s = setup()
    const remoteChannels = [...s.handlers.keys()].filter((channel) => /remote/i.test(channel))
    expect(remoteChannels.sort()).toEqual(
      [
        IPC.getRemoteStatus,
        IPC.getRemoteAlias,
        IPC.retryRemoteLoad,
        IPC.setRemoteEnabled,
        IPC.saveRemoteConnection,
        IPC.setRemoteWorkspaceShared,
        IPC.setRemoteShareTitles,
        IPC.setRemoteShareMessages,
        IPC.copyRemoteText
      ].sort()
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
