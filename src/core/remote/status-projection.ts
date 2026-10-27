import type { ToolHealth } from '../health'
import type { SessionKey, Session, UnknownReason } from '../session'
import type { SessionsSnapshot } from '../snapshot'
import { AGENT_TOOLS, type AgentTool } from '../tools'

// The Remote View status projection (TASK-009): turns a desktop snapshot into the minimal view a
// browser may receive. Every field is copied from an explicit allowlist, never by spreading a
// snapshot or session, so a field added to the desktop model stays on the Mac until it is added
// here on purpose. Message text, error text, paths, raw session IDs, tool versions, read cursors,
// pins and the fixture home never appear. TASK-003 wraps this view in the versioned envelope.

/** Proposed budgets from the Remote View architecture; TASK-003 may tighten them. */
export const REMOTE_STATUS_LIMITS = {
  maxSessions: 250,
  maxProjects: 50,
  /** Titles, aliases and project labels, in code points, including the ellipsis. */
  maxTextLength: 160
} as const

/** The only session fields that leave the Mac, in the order the projection writes them. */
export const REMOTE_SESSION_FIELDS = [
  'id',
  'tool',
  'title',
  'activity',
  'attention',
  'lastActivityAt'
] as const

export type RemoteActivity =
  | { state: 'running' }
  | { state: 'waiting' }
  | { state: 'idle' }
  | { state: 'unknown'; reason: UnknownReason }

export interface RemoteSession {
  /** Opaque per-viewer ID from the caller's minter; never the tool's own session ID. */
  id: string
  tool: AgentTool
  /** The tool's title when title sharing is on, otherwise a generic alias such as "Session 2". */
  title: string
  activity: RemoteActivity
  attention: { waiting: boolean; newReply: boolean; error: boolean }
  lastActivityAt: number
}

export interface RemoteProject {
  /** The folder name, with a numbered suffix when two shared folders share a name. Never a path. */
  label: string
  /** Newest activity first. */
  sessions: RemoteSession[]
}

/** Health without tool versions: only the state and, where it has one, the last read time. */
export type RemoteSourceHealth =
  | { state: 'off' | 'checking' | 'not-installed' | 'unsupported' }
  | { state: 'connected'; lastReadAt: number }
  | { state: 'no-access'; lastReadAt: number | null }

export interface RemoteStatus {
  /** When the desktop snapshot was made. Resending the same view never changes it. */
  observedAt: number
  sources: Record<AgentTool, RemoteSourceHealth>
  /** Shared projects in label order, including those with no sessions right now. */
  projects: RemoteProject[]
  /** How much the budgets left out, so the viewer can say the list is incomplete. */
  omitted: { projects: number; sessions: number }
}

/**
 * Mints the opaque ID for a session. The caller keys it with a Mac-local per-viewer secret (see
 * `src/main/remote/session-ids.ts`); the same secret must give the same ID for the same key.
 */
export type SessionIdMinter = (key: SessionKey) => string

export interface RemoteStatusPolicy {
  /** The exact workspace folders the owner shares. Children and worktrees are not included. */
  sharedWorkspaces: readonly string[]
  /** The "Share session titles" option. Off by default. */
  shareTitles: boolean
  mintId: SessionIdMinter
}

/** Projects a snapshot for Remote View. Pure: it never changes the snapshot or any local state. */
export function projectRemoteStatus(
  snapshot: SessionsSnapshot,
  policy: RemoteStatusPolicy
): RemoteStatus {
  const labels = projectLabels(policy.sharedWorkspaces)
  const projects = [...labels.entries()]
    .map(([workspace, label]) => ({ workspace, label }))
    .sort((a, b) => compare(a.label, b.label))
  const kept = projects.slice(0, REMOTE_STATUS_LIMITS.maxProjects)
  const keptLabels = new Map(kept.map((project) => [project.workspace, project.label]))

  const candidates: { label: string; session: RemoteSession }[] = []
  let omittedSessions = 0
  for (const session of snapshot.sessions) {
    const workspace = normalizeWorkspace(session.summary.workspacePath)
    if (workspace === null || !labels.has(workspace)) continue
    const label = keptLabels.get(workspace)
    if (label === undefined) {
      omittedSessions += 1
      continue
    }
    candidates.push({ label, session: projectSession(session, policy) })
  }

  candidates.sort((a, b) => compareSessions(a.session, b.session))
  omittedSessions += Math.max(0, candidates.length - REMOTE_STATUS_LIMITS.maxSessions)
  const rows = candidates.slice(0, REMOTE_STATUS_LIMITS.maxSessions)

  const byLabel = new Map<string, RemoteSession[]>(kept.map((project) => [project.label, []]))
  for (const row of rows) byLabel.get(row.label)?.push(row.session)
  for (const sessions of byLabel.values()) assignAliases(sessions, policy.shareTitles)

  const sources = {} as Record<AgentTool, RemoteSourceHealth>
  for (const tool of AGENT_TOOLS) sources[tool] = projectHealth(snapshot.health[tool])

  return {
    observedAt: snapshot.takenAt,
    sources,
    projects: kept.map((project) => ({
      label: project.label,
      sessions: byLabel.get(project.label) ?? []
    })),
    omitted: { projects: projects.length - kept.length, sessions: omittedSessions }
  }
}

function projectSession(session: Session, policy: RemoteStatusPolicy): RemoteSession {
  const title = policy.shareTitles ? cleanText(session.summary.title ?? '') : ''
  return {
    id: policy.mintId({ tool: session.key.tool, id: session.key.id }),
    tool: session.key.tool,
    // Filled with an alias later when titles are hidden, or when the tool has no usable title.
    title,
    activity: projectActivity(session.activity),
    attention: {
      waiting: session.attention.waiting,
      newReply: session.attention.newReply,
      error: session.attention.error
    },
    lastActivityAt: session.summary.lastActivityAt
  }
}

/** Drops `waitingFor`, which is tool text such as "permission prompt", and keeps the state. */
function projectActivity(activity: Session['activity']): RemoteActivity {
  switch (activity.state) {
    case 'running':
    case 'waiting':
    case 'idle':
      return { state: activity.state }
    case 'unknown':
      return { state: 'unknown', reason: activity.reason }
  }
}

function projectHealth(health: ToolHealth): RemoteSourceHealth {
  switch (health.state) {
    case 'connected':
      return { state: 'connected', lastReadAt: health.lastReadAt }
    case 'no-access':
      return { state: 'no-access', lastReadAt: health.lastReadAt }
    case 'unsupported':
      return { state: 'unsupported' }
    default:
      return { state: health.state }
  }
}

/**
 * Generic titles, numbered per project in opaque-ID order. The numbers depend only on which
 * sessions are listed, not on their activity, so a row keeps its alias while it moves in the list.
 * With title sharing on, only sessions without a usable title get one.
 */
function assignAliases(sessions: RemoteSession[], shareTitles: boolean): void {
  const order = [...sessions].sort((a, b) => compare(a.id, b.id))
  order.forEach((session, index) => {
    if (!shareTitles || session.title === '') session.title = `Session ${index + 1}`
  })
}

/**
 * Labels each exact shared folder by its name. Same-name folders, in path order, are labelled
 * "name", "name 2", "name 3"; a suffix that collides with another folder's name is skipped.
 */
function projectLabels(sharedWorkspaces: readonly string[]): Map<string, string> {
  const workspaces = [...new Set(sharedWorkspaces.map(normalizeWorkspace))]
    .filter((workspace): workspace is string => workspace !== null)
    .sort(compare)
  const bases = new Map(workspaces.map((workspace) => [workspace, folderName(workspace)]))
  const taken = new Set(bases.values())
  const used = new Set<string>()
  const labels = new Map<string, string>()
  for (const workspace of workspaces) {
    const base = bases.get(workspace) ?? 'Folder'
    let label = base
    for (let n = 2; used.has(label) || (label !== base && taken.has(label)); n += 1) {
      const suffix = ` ${n}`
      label = `${truncate(base, REMOTE_STATUS_LIMITS.maxTextLength - suffix.length)}${suffix}`
    }
    used.add(label)
    labels.set(workspace, label)
  }
  return labels
}

/** Exact-match form of a workspace path: trailing slashes removed, nothing else changed. */
function normalizeWorkspace(path: string | null): string | null {
  if (path === null) return null
  const trimmed = path.replace(/\/+$/, '')
  return trimmed.length > 0 && trimmed.startsWith('/') ? trimmed : null
}

function folderName(workspace: string): string {
  const name = cleanText(workspace.slice(workspace.lastIndexOf('/') + 1))
  return name.length > 0 ? name : 'Folder'
}

/** Removes control and bidi-override characters, collapses whitespace and applies the budget. */
function cleanText(text: string): string {
  const cleaned = text
    .replace(/[\p{Cc}\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  return truncate(cleaned, REMOTE_STATUS_LIMITS.maxTextLength)
}

/** Cuts to `max` code points, the last being an ellipsis, so surrogate pairs are never split. */
function truncate(text: string, max: number): string {
  const points = Array.from(text)
  if (points.length <= max) return text
  return `${points.slice(0, max - 1).join('')}…`
}

function compareSessions(a: RemoteSession, b: RemoteSession): number {
  if (a.lastActivityAt !== b.lastActivityAt) return b.lastActivityAt - a.lastActivityAt
  return compare(a.id, b.id)
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
