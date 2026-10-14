import { looksOpen } from './activity'
import type { Session } from './session'
import { sessionKeyToString } from './session'
import type { AgentTool } from './tools'

/** The three views in the sidebar's Sessions section. */
export type ViewId = 'active' | 'pinned' | 'all'

/**
 * A group of rows in the list. The Active view has the first five, in this order; the Pinned and
 * All Sessions views each have one group.
 */
export type GroupId =
  'waiting' | 'errors' | 'new-replies' | 'running' | 'unknown' | 'pinned' | 'all'

export interface SessionGroup {
  id: GroupId
  sessions: Session[]
}

/** The list header's tool filter. It applies to every view. */
export type ToolFilter = AgentTool | 'all'

export interface ViewContents {
  /** The groups to show, in order. Empty groups are left out. */
  groups: SessionGroup[]
  /** How many sessions the view holds for each filter choice, before the filter is applied. */
  toolCounts: Record<ToolFilter, number>
}

const ACTIVE_GROUP_ORDER: readonly GroupId[] = [
  'waiting',
  'errors',
  'new-replies',
  'running',
  'unknown'
]

/**
 * The Active view group a session belongs to: the first that matches, in display order, so each
 * session appears once. Null when the session is not active.
 */
export function activeGroupOf(session: Session): GroupId | null {
  const { activity, attention } = session
  if (activity.state === 'waiting') return 'waiting'
  if (attention.error) return 'errors'
  if (attention.newReply) return 'new-replies'
  if (activity.state === 'running') return 'running'
  if (activity.state === 'unknown' && looksOpen(activity.reason)) return 'unknown'
  return null
}

/** Builds a view's groups, sorted and filtered by tool. */
export function buildView(
  sessions: readonly Session[],
  view: ViewId,
  filter: ToolFilter
): ViewContents {
  const inView = sessionsInView(sessions, view)
  const toolCounts: Record<ToolFilter, number> = { all: inView.length, codex: 0, claude: 0 }
  for (const session of inView) toolCounts[session.key.tool] += 1

  const shown = filter === 'all' ? inView : inView.filter((session) => session.key.tool === filter)
  return { groups: groupSessions(shown, view), toolCounts }
}

function sessionsInView(sessions: readonly Session[], view: ViewId): Session[] {
  switch (view) {
    case 'active':
      return sessions.filter((session) => activeGroupOf(session) !== null)
    case 'pinned':
      return sessions.filter((session) => session.pinned)
    case 'all':
      return [...sessions]
  }
}

function groupSessions(sessions: Session[], view: ViewId): SessionGroup[] {
  switch (view) {
    case 'active':
      return ACTIVE_GROUP_ORDER.map((id) => ({
        id,
        sessions: sortSessions(
          sessions.filter((session) => activeGroupOf(session) === id),
          true
        )
      })).filter((group) => group.sessions.length > 0)
    case 'pinned':
      return nonEmpty({ id: 'pinned', sessions: sortSessions(sessions, false) })
    case 'all':
      return nonEmpty({ id: 'all', sessions: sortSessions(sessions, true) })
  }
}

function nonEmpty(group: SessionGroup): SessionGroup[] {
  return group.sessions.length > 0 ? [group] : []
}

/**
 * Sorts by newest activity, with pinned sessions first when `pinnedFirst` is set. Ties fall back to
 * the session key, so the order never depends on the order the sessions arrived in.
 */
export function sortSessions(sessions: readonly Session[], pinnedFirst: boolean): Session[] {
  return [...sessions].sort((a, b) => {
    if (pinnedFirst && a.pinned !== b.pinned) return a.pinned ? -1 : 1
    if (a.summary.lastActivityAt !== b.summary.lastActivityAt) {
      return b.summary.lastActivityAt - a.summary.lastActivityAt
    }
    const keyA = sessionKeyToString(a.key)
    const keyB = sessionKeyToString(b.key)
    return keyA < keyB ? -1 : keyA > keyB ? 1 : 0
  })
}
