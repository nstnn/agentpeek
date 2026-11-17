import { looksOpen } from '../../../src/core/activity'
import type { AgentTool } from '../../../src/core/tools'
import type {
  RemoteSession,
  RemoteSourceHealth,
  RemoteStatus
} from '../../../src/core/remote/status-projection'

// What the session list shows from one status (TASK-018), as pure functions of the status, the
// page's choices and the Mac clock. The page follows the desktop window: an Active and an All
// Sessions view, grouped by status (the desktop's Active groups) or by project, with a tool filter.
// Labels follow the desktop's row status order and wording, kept here because the page may not
// import the desktop renderer.

export type RowKind = 'waiting' | 'error' | 'reply' | 'unknown' | 'running' | 'idle'

export const toolName = (tool: AgentTool): string => (tool === 'codex' ? 'Codex' : 'Claude Code')

const WAITING_LABELS = {
  permission: 'Permission',
  question: 'Question',
  dialog: 'Dialog',
  sandbox: 'Sandbox',
  worker: 'Worker',
  goal: 'Goal',
  other: null
} as const

const UNKNOWN_LABELS = {
  'process-ended': 'Process ended',
  'app-not-running': 'Codex not running',
  quiet: 'Quiet for 30 min',
  unreadable: "Can't read",
  unsupported: 'Unsupported format'
} as const

/** One status label per row, in the desktop's order. The Mac sends no error code in M1. */
export function rowStatus(session: RemoteSession): { kind: RowKind; label: string } {
  const { activity, attention } = session
  if (activity.state === 'waiting') {
    const reason = WAITING_LABELS[activity.kind]
    return { kind: 'waiting', label: reason ? `Waiting for you · ${reason}` : 'Waiting for you' }
  }
  if (attention.waiting) return { kind: 'waiting', label: 'Waiting for you' }
  if (attention.error) return { kind: 'error', label: 'Error' }
  if (attention.newReply) return { kind: 'reply', label: 'New reply' }
  if (activity.state === 'unknown') {
    return { kind: 'unknown', label: `Unknown · ${UNKNOWN_LABELS[activity.reason]}` }
  }
  return activity.state === 'running'
    ? { kind: 'running', label: 'Running' }
    : { kind: 'idle', label: 'Idle' }
}

const ATTENTION_ORDER: Partial<Record<RowKind, number>> = { waiting: 0, error: 1, reply: 2 }

export interface Row {
  session: RemoteSession
  project: string
  kind: RowKind
  label: string
}

/**
 * A duration on the Mac clock in words. The page measures ages to its estimate of the Mac's now
 * (`macNow` while live, the last frame's time for kept data), never to this device's clock.
 */
export function durationText(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000)
  if (minutes < 1) return 'under 1 min'
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h`
  return `${Math.floor(hours / 24)} d`
}

/**
 * The row's time: how long an attention row has been in that state ("for 4 min"), or when any
 * other row was last active ("2 min ago"). A waiting-only row has no known start, so no time.
 */
export function rowTime(row: Row, checkedAt: number): { at: number; text: string } | null {
  if (ATTENTION_ORDER[row.kind] !== undefined) {
    const since = row.session.attentionSince
    return since === null ? null : { at: since, text: `for ${durationText(checkedAt - since)}` }
  }
  const at = row.session.lastActivityAt
  const age = checkedAt - at
  if (age < 60_000) return { at, text: 'just now' }
  if (age < WEEK) return { at, text: `${durationText(age)} ago` }
  const sameYear = new Date(at).getFullYear() === new Date(checkedAt).getFullYear()
  return { at, text: `on ${(sameYear ? dayFormat : yearFormat).format(new Date(at))}` }
}

const WEEK = 7 * 24 * 3_600_000
const dayFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const yearFormat = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric'
})

/** A line for each source the Mac cannot read; the other source's rows stay. */
export function sourceIssues(sources: Record<AgentTool, RemoteSourceHealth>): string[] {
  return (['codex', 'claude'] as const).flatMap((tool) => {
    switch (sources[tool].state) {
      case 'no-access':
        return [`${toolName(tool)}: no access on the Mac.`]
      case 'unsupported':
        return [`${toolName(tool)}: unsupported format on the Mac.`]
      default:
        return []
    }
  })
}

export function omittedText(omitted: RemoteStatus['omitted']): string | null {
  if (omitted.projects === 0 && omitted.sessions === 0) return null
  const projects = `${omitted.projects} project${omitted.projects === 1 ? '' : 's'}`
  const sessions = `${omitted.sessions} session${omitted.sessions === 1 ? '' : 's'}`
  return `Not everything fits: ${projects} and ${sessions} left out.`
}

/** The sidebar's views. The desktop's Pinned view has no remote counterpart: pins stay on the Mac. */
export type ViewId = 'active' | 'all'
export type Grouping = 'status' | 'project'

/** What the page shows. Page state only: never in the address, history or storage. */
export interface ListChoices {
  view: ViewId
  grouping: Grouping
  tool: AgentTool | null
}

export const DEFAULT_CHOICES: ListChoices = { view: 'active', grouping: 'status', tool: null }

export const VIEW_NAMES: Record<ViewId, string> = { active: 'Active', all: 'All Sessions' }

type StatusGroupId = 'waiting' | 'errors' | 'new-replies' | 'running' | 'unknown'

const STATUS_GROUPS: readonly { id: StatusGroupId; label: string; outstanding: boolean }[] = [
  { id: 'waiting', label: 'Waiting for you', outstanding: true },
  { id: 'errors', label: 'Errors', outstanding: true },
  { id: 'new-replies', label: 'New replies', outstanding: true },
  { id: 'running', label: 'Running', outstanding: false },
  { id: 'unknown', label: 'Unknown', outstanding: false }
]

/** The desktop's Active group for a session (`activeGroupOf`), or null when it is not active. */
export function activeGroupOf(session: RemoteSession): StatusGroupId | null {
  const { activity, attention } = session
  if (activity.state === 'waiting' || attention.waiting) return 'waiting'
  if (attention.error) return 'errors'
  if (attention.newReply) return 'new-replies'
  if (activity.state === 'running') return 'running'
  if (activity.state === 'unknown' && looksOpen(activity.reason)) return 'unknown'
  return null
}

export interface ListGroup {
  /** Stable within one status: a status group ID or `project:<label>`. */
  id: string
  label: string
  rows: Row[]
  /** The heading's right side, for example "2 outstanding" or "1 need attention · 3 running". */
  note: string
}

export interface ListView {
  /** The sidebar: sessions that need attention (the Active badge) and every shared session. */
  needsAttention: number
  total: number
  /** Sessions in the current view per tool choice, before the tool filter. */
  toolCounts: { all: number; codex: number; claude: number }
  /** Tool choices are shown only when both tools have sessions somewhere, or one is chosen. */
  toolChoices: boolean
  groups: ListGroup[]
  /** Rows shown after the tool filter. */
  shown: number
}

const newestFirst = (a: Row, b: Row): number =>
  b.session.lastActivityAt - a.session.lastActivityAt ||
  (a.session.id < b.session.id ? -1 : a.session.id > b.session.id ? 1 : 0)

export function listView(status: RemoteStatus, choices: ListChoices): ListView {
  const rows: Row[] = []
  const tools = new Set<AgentTool>()
  let needsAttention = 0
  for (const project of status.projects) {
    for (const session of project.sessions) {
      tools.add(session.tool)
      const row = { session, project: project.label, ...rowStatus(session) }
      if (ATTENTION_ORDER[row.kind] !== undefined) needsAttention += 1
      rows.push(row)
    }
  }
  const inView =
    choices.view === 'active' ? rows.filter((row) => activeGroupOf(row.session) !== null) : rows
  const toolCounts = { all: inView.length, codex: 0, claude: 0 }
  for (const row of inView) toolCounts[row.session.tool] += 1
  const shownRows = (
    choices.tool === null ? inView : inView.filter((row) => row.session.tool === choices.tool)
  ).sort(newestFirst)

  let groups: ListGroup[]
  if (choices.grouping === 'project') {
    groups = status.projects.flatMap((project) => {
      const members = shownRows.filter((row) => row.project === project.label)
      if (members.length === 0) return []
      const attention = members.filter((row) => ATTENTION_ORDER[row.kind] !== undefined).length
      const running = members.filter((row) => row.kind === 'running').length
      const note = [
        attention > 0 ? `${attention} need attention` : '',
        running > 0 ? `${running} running` : ''
      ]
        .filter(Boolean)
        .join(' · ')
      return [{ id: `project:${project.label}`, label: project.label, rows: members, note }]
    })
  } else if (choices.view === 'active') {
    groups = STATUS_GROUPS.flatMap(({ id, label, outstanding }) => {
      const members = shownRows.filter((row) => activeGroupOf(row.session) === id)
      if (members.length === 0) return []
      const note = `${members.length} ${outstanding ? 'outstanding' : 'current'}`
      return [{ id, label, rows: members, note }]
    })
  } else {
    groups =
      shownRows.length > 0
        ? [{ id: 'all', label: VIEW_NAMES.all, rows: shownRows, note: `${shownRows.length}` }]
        : []
  }
  return {
    needsAttention,
    total: rows.length,
    toolCounts,
    toolChoices: tools.size > 1 || choices.tool !== null,
    groups,
    shown: shownRows.length
  }
}

/** The list header line, like the desktop's: "1 need attention · 6 running · 0 unknown". */
export function viewSummary(status: RemoteStatus): string {
  let attention = 0
  let running = 0
  let unknown = 0
  for (const project of status.projects) {
    for (const session of project.sessions) {
      const group = activeGroupOf(session)
      if (group === 'running') running += 1
      else if (group === 'unknown') unknown += 1
      else if (group !== null) attention += 1
    }
  }
  return `${attention} need attention · ${running} running · ${unknown} unknown`
}

/** One line per source for the sidebar footer, in the desktop's order. */
export function sourceLines(
  sources: Record<AgentTool, RemoteSourceHealth>
): { tool: AgentTool; name: string; state: RemoteSourceHealth['state']; text: string }[] {
  const words: Record<RemoteSourceHealth['state'], string> = {
    off: 'Off',
    checking: 'Checking',
    'not-installed': 'Not installed',
    unsupported: 'Unsupported format',
    connected: 'Connected',
    'no-access': 'No access'
  }
  return (['codex', 'claude'] as const).map((tool) => ({
    tool,
    name: toolName(tool),
    state: sources[tool].state,
    text: words[sources[tool].state]
  }))
}
