import { vi } from 'vitest'
import type { AgentPeekApi, AppSnapshot, MenuCommand } from '../shared/api'
import { createSnapshot } from '../core/snapshot'
import type { Session } from '../core/session'

export const NOW = new Date('2026-10-18T12:00:00').getTime()
export function session(id: string, change: Partial<Session> = {}): Session {
  return {
    key: { tool: 'codex', id },
    summary: {
      title: `Synthetic ${id}`,
      workspacePath: '/synthetic/project',
      lastActivityAt: NOW - 120_000,
      toolVersion: '0.162'
    },
    activity: { state: 'running' },
    attention: { waiting: false, error: false, newReply: false },
    lastReply: null,
    pinned: false,
    ...change
  }
}
export function snapshot(sessions: Session[] = [], change: Partial<AppSnapshot> = {}): AppSnapshot {
  return {
    ...createSnapshot({
      sessions,
      health: {
        codex: { state: 'connected', lastReadAt: NOW },
        claude: { state: 'connected', lastReadAt: NOW }
      },
      localState: { kind: 'available' },
      firstLaunch: false,
      fixture: true,
      takenAt: NOW
    }),
    fixtureHome: '/synthetic/home',
    ...change
  }
}
export function fakeApi(initial = snapshot()) {
  let receive: ((s: AppSnapshot) => void) | null = null
  let command: ((c: MenuCommand) => void) | null = null
  const offSnapshot = vi.fn()
  const offCommand = vi.fn()
  const api = {
    getSnapshot: vi.fn(() => Promise.resolve(initial)),
    onSnapshot: vi.fn((fn: (s: AppSnapshot) => void) => {
      receive = fn
      return offSnapshot
    }),
    onCommand: vi.fn((fn: (c: MenuCommand) => void) => {
      command = fn
      return offCommand
    }),
    getMessages: vi
      .fn<AgentPeekApi['getMessages']>()
      .mockResolvedValue({ kind: 'messages', messages: [], hasOlder: false }),
    setPinned: vi.fn(() => Promise.resolve(true)),
    markRead: vi.fn(() => Promise.resolve(true)),
    openTool: vi.fn(() => Promise.resolve(true)),
    copySessionId: vi.fn(() => Promise.resolve(true)),
    openLink: vi.fn(() => Promise.resolve(true)),
    reload: vi.fn(() => Promise.resolve()),
    setSelection: vi.fn(() => Promise.resolve()),
    setDetailOpen: vi.fn(() => Promise.resolve()),
    showSessionMenu: vi.fn<AgentPeekApi['showSessionMenu']>(() => Promise.resolve())
  } satisfies AgentPeekApi
  return {
    api,
    push: (s: AppSnapshot) => receive?.(s),
    command: (c: MenuCommand) => command?.(c),
    offSnapshot,
    offCommand
  }
}
