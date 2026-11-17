import { describe, expect, it, vi } from 'vitest'
import { IPC } from '../shared/ipc'
import { createPreloadApi } from './api'

describe('preload API', () => {
  function setup() {
    const transport = {
      invoke: vi.fn().mockResolvedValue(true),
      on: vi.fn(),
      removeListener: vi.fn()
    }
    return { transport, api: createPreloadApi(transport) }
  }
  it('exposes only the specified capabilities, without a raw IPC or Node object', () => {
    const { api } = setup()
    expect(Object.keys(api).sort()).toEqual(
      [
        'getTheme',
        'setTheme',
        'setSourceEnabled',
        'getSnapshot',
        'onSnapshot',
        'getMessages',
        'getSkill',
        'setPinned',
        'markRead',
        'openTool',
        'copySessionId',
        'openLink',
        'reload',
        'setSelection',
        'setDetailOpen',
        'showSessionMenu',
        'onCommand',
        'getRemoteStatus',
        'onRemoteStatus',
        'getRemoteAlias',
        'retryRemoteLoad',
        'setRemoteEnabled',
        'saveRemoteConnection',
        'setRemoteWorkspaceShared',
        'setRemoteShareTitles',
        'setRemoteShareMessages',
        'copyRemoteText'
      ].sort()
    )
    expect(Object.isFrozen(api)).toBe(true)
  })
  it('uses fixed channels and forwards plain arguments and results', async () => {
    const { api, transport } = setup()
    const key = { tool: 'codex', id: 'synthetic' } as const
    await api.getSnapshot()
    await api.getTheme()
    await api.setTheme('dark')
    await api.setSourceEnabled('codex', false)
    await api.getMessages(key, 10)
    const skill = { at: 1, name: 'pr', path: '/synthetic/.agents/skills/pr/SKILL.md' }
    await api.getSkill(key, skill)
    await api.setPinned(key, true)
    await api.markRead(key)
    await api.openTool(key)
    await api.copySessionId(key)
    await api.openLink('https://example.com')
    await api.reload()
    await api.setSelection(null)
    await api.setSelection(key, { secondPaneOpen: true })
    await api.setDetailOpen(true)
    await api.showSessionMenu(key)
    await api.getRemoteStatus()
    await api.getRemoteAlias(key)
    await api.retryRemoteLoad()
    await api.setRemoteEnabled(true)
    const connection = { ownerLogin: 'owner@example.com', hostName: 'mac.tailnet.ts.net', port: 1 }
    // Extra properties on a caller's object never cross the bridge.
    await api.saveRemoteConnection({ ...connection, enabled: true } as typeof connection)
    await api.setRemoteWorkspaceShared('/synthetic/demo', false)
    await api.setRemoteShareTitles(true)
    await api.setRemoteShareMessages(true)
    await api.copyRemoteText('serve-command')
    expect(transport.invoke.mock.calls).toEqual([
      [IPC.getSnapshot],
      [IPC.getTheme],
      [IPC.setTheme, 'dark'],
      [IPC.setSourceEnabled, 'codex', false],
      [IPC.getMessages, key, 10],
      [IPC.getSkill, key, skill],
      [IPC.setPinned, key, true],
      [IPC.markRead, key],
      [IPC.openTool, key],
      [IPC.copySessionId, key],
      [IPC.openLink, 'https://example.com'],
      [IPC.reload],
      [IPC.setSelection, null],
      [IPC.setSelection, key, { secondPaneOpen: true }],
      [IPC.setDetailOpen, true],
      [IPC.showSessionMenu, key],
      [IPC.getRemoteStatus],
      [IPC.getRemoteAlias, key],
      [IPC.retryRemoteLoad],
      [IPC.setRemoteEnabled, true],
      [IPC.saveRemoteConnection, connection],
      [IPC.setRemoteWorkspaceShared, '/synthetic/demo', false],
      [IPC.setRemoteShareTitles, true],
      [IPC.setRemoteShareMessages, true],
      [IPC.copyRemoteText, 'serve-command']
    ])
  })
  it.each(['snapshot', 'command', 'remoteStatus'] as const)(
    'strips the Electron event and removes exactly its own %s listener',
    (kind) => {
      const { api, transport } = setup()
      const callback = vi.fn()
      const unsubscribe =
        kind === 'snapshot'
          ? api.onSnapshot(callback)
          : kind === 'command'
            ? api.onCommand(callback)
            : api.onRemoteStatus(callback)
      const [channel, listener] = transport.on.mock.calls[0] as [
        string,
        (event: unknown, value: unknown) => void
      ]
      const payload =
        kind === 'snapshot'
          ? { sessions: [] }
          : kind === 'remoteStatus'
            ? { state: 'loading' }
            : { type: 'open-secondary', key: { tool: 'codex', id: 'synthetic' } }
      listener({ sender: 'must never escape' }, payload)
      expect(callback.mock.calls).toEqual([[payload]])
      unsubscribe()
      expect(transport.removeListener).toHaveBeenCalledWith(channel, listener)
      expect(channel).toBe(IPC[kind])
    }
  )
})
