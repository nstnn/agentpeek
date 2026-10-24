// Synthetic fakes shared by the main-process boundary tests, never imported by the app.
import { vi } from 'vitest'
import type { Session } from '../core/session'
import { createSnapshot } from '../core/snapshot'
import type { SessionsService } from './sessions/service'
import type { SystemActions } from './system-actions'

export function testSession(change: Partial<Session> = {}): Session {
  return {
    key: { tool: 'codex', id: 'synthetic-session' },
    summary: {
      title: 'Synthetic session',
      workspacePath: '/synthetic',
      lastActivityAt: 1,
      toolVersion: '0.162'
    },
    activity: { state: 'idle' },
    attention: { waiting: false, newReply: false, error: false },
    lastReply: null,
    pinned: false,
    ...change
  }
}

export function testService(sessions: Session[] = [testSession()]) {
  const snapshot = createSnapshot({
    sessions,
    health: { codex: { state: 'connected', lastReadAt: 1 }, claude: { state: 'not-installed' } },
    localState: { kind: 'available' },
    firstLaunch: true,
    fixture: true,
    takenAt: 1
  })
  return {
    setSourceEnabled: vi.fn<SessionsService['setSourceEnabled']>().mockResolvedValue(undefined),
    start: vi.fn<SessionsService['start']>().mockResolvedValue(undefined),
    reconcile: vi.fn<SessionsService['reconcile']>().mockResolvedValue(undefined),
    snapshot: vi.fn(() => snapshot),
    recentMessages: vi
      .fn<SessionsService['recentMessages']>()
      .mockResolvedValue({ kind: 'messages', messages: [], hasOlder: false }),
    setPinned: vi.fn(() => true),
    markRead: vi.fn(() => true),
    stop: vi.fn<SessionsService['stop']>().mockResolvedValue(undefined)
  } satisfies SessionsService
}

export function testSystem() {
  return {
    openTool: vi.fn<SystemActions['openTool']>().mockResolvedValue(true),
    copyText: vi.fn<SystemActions['copyText']>().mockResolvedValue(undefined),
    openLink: vi.fn<SystemActions['openLink']>().mockResolvedValue(true)
  } satisfies SystemActions
}
