import { countNeedingAttention } from './attention'
import { looksOpen } from './activity'
import type { ToolHealth } from './health'
import type { Session } from './session'
import { AGENT_TOOLS, type AgentTool } from './tools'
import { inboxGroupOf, type GroupId, sortSessions } from './views'

// The snapshot the sessions service publishes: everything the list and the detail header show,
// as plain, frozen data that can cross the IPC bridge. Messages are never part of it; the detail
// asks for them separately.

/**
 * Whether AgentPeek's own `state.json` is saved (REQ-010).
 * - `newer-version` and `unreadable`: the saved file was left unchanged and is never written. Pins
 *   and read markers last until quit.
 * - `unwritable`: the last save failed, or the state grew too large to save. The next change tries
 *   again.
 */
export type LocalStateStatus =
  | { kind: 'available' }
  | { kind: 'unavailable'; reason: 'newer-version' | 'unreadable' | 'unwritable' }

export interface SessionsSnapshot {
  /** Every listed session of both tools, newest activity first. */
  readonly sessions: readonly Session[]
  /** How many sessions need attention, each counted once, across both tools. */
  readonly needsAttention: number
  /** How many sessions each group holds, before the tool filter. */
  readonly groupCounts: Readonly<Record<GroupId, number>>
  /** Each tool's health line. */
  readonly health: Readonly<Record<AgentTool, ToolHealth>>
  /** Whether pins and read markers are saved, for the "Local state unavailable" banner. */
  readonly localState: LocalStateStatus
  /**
   * True when AgentPeek had read neither tool before this launch, so every reply that finished
   * before now counts as read: the "First launch" strip. False while the saved state cannot be
   * loaded, when the "Local state unavailable" banner shows instead.
   */
  readonly firstLaunch: boolean
  /** True when AgentPeek shows synthetic data (`AGENTPEEK_HOME`): the "Fixture data" banner. */
  readonly fixture: boolean
  /** When the snapshot was made: the "as of" time. */
  readonly takenAt: number
}

export interface SnapshotInput {
  sessions: readonly Session[]
  health: Record<AgentTool, ToolHealth>
  localState: LocalStateStatus
  firstLaunch: boolean
  fixture: boolean
  takenAt: number
}

/**
 * Builds a snapshot from derived sessions. The result is a frozen copy at every level: it shares no
 * object with its input (the sources' facts, the store's status), so it never changes later.
 */
export function createSnapshot(input: SnapshotInput): SessionsSnapshot {
  const sessions = sortSessions(input.sessions, false).map(frozenSession)
  const health = {} as Record<AgentTool, ToolHealth>
  for (const tool of AGENT_TOOLS) health[tool] = Object.freeze({ ...input.health[tool] })
  return Object.freeze({
    sessions: Object.freeze(sessions),
    needsAttention: countNeedingAttention(sessions),
    groupCounts: Object.freeze(countGroups(sessions)),
    health: Object.freeze(health),
    localState: Object.freeze({ ...input.localState }),
    firstLaunch: input.firstLaunch,
    fixture: input.fixture,
    takenAt: input.takenAt
  })
}

/** A frozen copy of a session. Each part of a session is a flat object, so one copy each is enough. */
function frozenSession(session: Session): Session {
  return Object.freeze({
    key: Object.freeze({ ...session.key }),
    ...(session.appSessionId ? { appSessionId: session.appSessionId } : {}),
    summary: Object.freeze({ ...session.summary }),
    activity: Object.freeze({ ...session.activity }),
    attention: Object.freeze({ ...session.attention }),
    lastReply: session.lastReply === null ? null : Object.freeze({ ...session.lastReply }),
    ...(session.unavailable ? { unavailable: true as const } : {}),
    pinned: session.pinned
  })
}

/**
 * Status counts, with Running ahead of unread results, plus Pinned and All Sessions totals.
 */
export function countGroups(sessions: readonly Session[]): Record<GroupId, number> {
  const counts: Record<GroupId, number> = {
    waiting: 0,
    errors: 0,
    'new-replies': 0,
    running: 0,
    unknown: 0,
    pinned: 0,
    all: sessions.length
  }
  for (const session of sessions) {
    const group = session.activity.state === 'running' ? 'running' : inboxGroupOf(session)
    if (group !== null) counts[group] += 1
    else if (session.activity.state === 'waiting') counts.waiting += 1
    else if (session.activity.state === 'unknown' && looksOpen(session.activity.reason))
      counts.unknown += 1
    if (session.pinned) counts.pinned += 1
  }
  return counts
}
