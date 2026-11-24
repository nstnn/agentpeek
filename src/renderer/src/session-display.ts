import type { ToolHealth } from '../../core/health'
import type { Session } from '../../core/session'
import type { AgentTool } from '../../core/tools'
import type { GroupId, ViewId } from '../../core/views'

export const VIEW_NAMES: Record<ViewId, string> = {
  active: 'Active',
  inbox: 'Inbox',
  pinned: 'Pinned',
  all: 'All Sessions'
}
export const GROUP_NAMES: Record<GroupId, string> = {
  waiting: 'Waiting for you',
  errors: 'Errors',
  'new-replies': 'New replies',
  running: 'Running',
  unknown: 'Unknown',
  pinned: 'Pinned',
  all: 'All Sessions'
}
/** "7 days", "1 year", "2 years": the loaded range in words. */
export function rangeDays(days: number): string {
  if (days % 365 === 0) return days === 365 ? '1 year' : `${days / 365} years`
  return days === 1 ? '1 day' : `${days} days`
}

const TOOL_NAMES: Readonly<Record<AgentTool, string>> = {
  codex: 'Codex',
  claude: 'Claude Code',
  antigravity: 'Antigravity'
}
const TOOL_HOMES: Readonly<Record<AgentTool, string>> = {
  codex: '~/.codex',
  claude: '~/.claude',
  antigravity: '~/.gemini/antigravity'
}
export const toolName = (tool: AgentTool): string => TOOL_NAMES[tool]
export const toolHome = (tool: AgentTool): string => TOOL_HOMES[tool]
export const sessionTitle = (session: Session): string =>
  session.summary.title ||
  `${session.unavailable ? `Unavailable ${session.pinned ? 'pinned ' : ''}session` : 'Untitled session'} · ${session.key.id.slice(0, 6)}`
export const workspaceName = (session: Session): string =>
  session.summary.workspacePath?.split('/').filter(Boolean).at(-1) ||
  (session.summary.workspacePath === '/' ? '/' : 'No folder')

const WAITING: Record<string, string> = {
  'permission prompt': 'Permission',
  'input needed': 'Question',
  'dialog open': 'Dialog',
  'sandbox request': 'Sandbox',
  'worker request': 'Worker',
  'goal proposal': 'Goal'
}
const UNKNOWN = {
  'process-ended': 'Process ended',
  'app-not-running': 'Codex not running',
  quiet: 'Quiet for 30 min',
  unreadable: "Can't read",
  unsupported: 'Unsupported format'
}
export function rowStatus(session: Session, missing = false): { kind: string; label: string } {
  if (session.unavailable) return { kind: 'unknown', label: 'Unavailable' }
  if (missing)
    return { kind: 'unknown', label: `Unavailable — last known: ${rowStatus(session).label}` }
  const activity = session.activity
  if (activity.state === 'running') return { kind: 'running', label: 'Running' }
  if (activity.state === 'waiting') {
    const reason = WAITING[activity.waitingFor ?? '']
    return { kind: 'waiting', label: `Waiting for you${reason ? ` · ${reason}` : ''}` }
  }
  if (
    session.attention.error ||
    (session.lastReply?.isError && !session.lastReply.newerTurnStarted)
  ) {
    const code = session.lastReply?.errorCode
    const label = code ? code.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase()) : null
    return {
      kind: 'error',
      label: session.attention.error ? `Error${label ? ` · ${label}` : ''}` : 'Error · Read'
    }
  }
  if (session.attention.newReply) return { kind: 'reply', label: 'New reply' }
  if (activity.state === 'unknown') {
    const reason =
      activity.reason === 'app-not-running' && session.key.tool === 'antigravity'
        ? 'Antigravity activity unconfirmed'
        : UNKNOWN[activity.reason]
    return { kind: 'unknown', label: `Unknown · ${reason}` }
  }
  return { kind: 'idle', label: 'Idle' }
}

export function relativeTime(at: number, now: number): string {
  const age = Math.max(0, now - at)
  if (age < 60_000) return 'now'
  if (age < 3_600_000) return `${Math.floor(age / 60_000)} min`
  const date = new Date(at)
  const today = new Date(now)
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday'
  if (age < 86_400_000) return `${Math.floor(age / 3_600_000)} h`
  if (age < 7 * 86_400_000) return date.toLocaleDateString('en-US', { weekday: 'short' })
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function healthCopy(tool: AgentTool, health: ToolHealth): { label: string; detail: string } {
  switch (health.state) {
    case 'off':
      return { label: 'Monitoring off', detail: '' }
    case 'checking':
      return { label: 'Checking…', detail: '—' }
    case 'connected':
      return { label: 'Connected', detail: `Updated ${clockTime(health.lastReadAt)}` }
    case 'not-installed':
      return { label: 'Not installed', detail: `Looks in ${toolHome(tool)}` }
    case 'no-access':
      return {
        label: 'No access',
        detail: health.lastReadAt === null ? '' : `Last updated ${clockTime(health.lastReadAt)}`
      }
    case 'unsupported':
      return {
        label: 'Unsupported format',
        detail: `${toolName(tool)} ${health.toolVersion ?? '(unknown version)'}`
      }
  }
}

function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString('en-US', { hour12: false })
}
