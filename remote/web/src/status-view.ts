import type { AgentTool } from '../../../src/core/tools'
import type {
  RemoteSession,
  RemoteSourceHealth,
  RemoteStatus
} from '../../../src/core/remote/status-projection'

// What the session list shows from one status (TASK-018), as pure functions of the status, the
// page's filters and the Mac clock. Option A of the UX contract: one cross-project "Needs
// attention" group (waiting, errors, new replies, oldest attention first), then each shared
// project with the rest. Labels follow the desktop's row status order and wording, kept here
// because the page may not import the desktop renderer.

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

/** The page's filters. Page state only: never in the address, history or storage. */
export interface Filters {
  /** A project label from the current status, or null for every project. */
  project: string | null
  tool: AgentTool | null
}

export const NO_FILTERS: Filters = { project: null, tool: null }

export interface Row {
  session: RemoteSession
  project: string
  kind: RowKind
  label: string
}

export interface StatusView {
  /** Counts over every shared session, whatever the filters: "is anything waiting?". */
  counts: { waiting: number; error: number; reply: number }
  attention: Row[]
  projects: { label: string; rows: Row[]; total: number }[]
  /** Filter choices that would change something; an active filter always keeps its control. */
  projectChoices: string[]
  toolChoices: AgentTool[]
  /** Filters with a project that is no longer shared dropped. */
  filters: Filters
}

export function statusView(status: RemoteStatus, requested: Filters): StatusView {
  const labels = status.projects.map((project) => project.label)
  const filters: Filters = {
    project:
      requested.project !== null && labels.includes(requested.project) ? requested.project : null,
    tool: requested.tool
  }
  const counts = { waiting: 0, error: 0, reply: 0 }
  const tools = new Set<AgentTool>()
  const attention: Row[] = []
  const projects: StatusView['projects'] = []
  for (const project of status.projects) {
    const rows: Row[] = []
    for (const session of project.sessions) {
      tools.add(session.tool)
      const row = { session, project: project.label, ...rowStatus(session) }
      if (row.kind === 'waiting' || row.kind === 'error' || row.kind === 'reply') {
        counts[row.kind] += 1
      }
      if (filters.project !== null && filters.project !== project.label) continue
      if (filters.tool !== null && filters.tool !== session.tool) continue
      if (ATTENTION_ORDER[row.kind] === undefined) rows.push(row)
      else attention.push(row)
    }
    if (filters.project !== null && filters.project !== project.label) continue
    projects.push({ label: project.label, rows, total: project.sessions.length })
  }
  attention.sort(
    (a, b) =>
      ATTENTION_ORDER[a.kind]! - ATTENTION_ORDER[b.kind]! ||
      attentionTime(a.session) - attentionTime(b.session) ||
      (a.session.id < b.session.id ? -1 : a.session.id > b.session.id ? 1 : 0)
  )
  return {
    counts,
    attention,
    projects,
    projectChoices: labels.length > 1 || filters.project !== null ? labels : [],
    toolChoices:
      tools.size > 1 || filters.tool !== null ? (['codex', 'claude'] as const).slice() : [],
    filters
  }
}

/** Oldest attention first; a waiting-only row has no start time, so its last activity stands in. */
const attentionTime = (session: RemoteSession): number =>
  session.attentionSince ?? session.lastActivityAt

/** The header summary, for example "2 need you · 1 error · 1 new reply"; empty when none. */
export function summaryText(counts: StatusView['counts']): string {
  const parts: string[] = []
  if (counts.waiting > 0) parts.push(`${counts.waiting} need${counts.waiting === 1 ? 's' : ''} you`)
  if (counts.error > 0) parts.push(`${counts.error} error${counts.error === 1 ? '' : 's'}`)
  if (counts.reply > 0) parts.push(`${counts.reply} new repl${counts.reply === 1 ? 'y' : 'ies'}`)
  return parts.join(' · ')
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
