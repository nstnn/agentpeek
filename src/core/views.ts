import type { Session } from './session'
import { sessionKeyToString } from './session'
import type { AgentTool } from './tools'

/** The views in the sidebar's Sessions section. */
export type ViewId = 'active' | 'inbox' | 'pinned' | 'all'

/**
 * Active holds Running; Inbox holds unread Errors and New replies.
 * Pinned and All Sessions each have one group. Waiting/Unknown remain snapshot status counts.
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

const INBOX_GROUP_ORDER: readonly GroupId[] = ['errors', 'new-replies']

/**
 * Non-running sessions with unread results, each in its first matching group.
 * A new run always belongs to Active, even if an older reply remains unread.
 */
export function inboxGroupOf(session: Session): GroupId | null {
  const { activity, attention } = session
  if (activity.state === 'running') return null
  if (attention.error) return 'errors'
  if (attention.newReply) return 'new-replies'
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
      return sessions.filter((session) => session.activity.state === 'running')
    case 'inbox':
      return sessions.filter((session) => inboxGroupOf(session) !== null)
    case 'pinned':
      return sessions.filter((session) => session.pinned)
    case 'all':
      return [...sessions]
  }
}

function groupSessions(sessions: Session[], view: ViewId): SessionGroup[] {
  switch (view) {
    case 'active':
      return nonEmpty({ id: 'running', sessions: sortSessions(sessions, true) })
    case 'inbox':
      return INBOX_GROUP_ORDER.map((id) => ({
        id,
        sessions: sortSessions(
          sessions.filter((session) => inboxGroupOf(session) === id),
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
