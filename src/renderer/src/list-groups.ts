import type { Session } from '../../core/session'
import { buildView, sortSessions, type ToolFilter, type ViewId } from '../../core/views'
import { GROUP_NAMES } from './session-display'

export type Grouping = 'project' | 'status'
export interface ListGroup {
  id: string
  label: string
  /** Undefined for a status group; null for sessions without a working folder. */
  projectPath?: string | null
  sessions: Session[]
}

export function projectId(session: Session): string {
  const path = session.summary.workspacePath
  return `project:${path ? path.replace(/\/+$/, '') || '/' : ''}`
}

export function listGroup(id: string, sessions: Session[] = []): ListGroup {
  if (id.startsWith('project:')) {
    const projectPath = id.slice('project:'.length) || null
    return {
      id,
      label: projectPath?.split('/').filter(Boolean).at(-1) || projectPath || 'No folder',
      projectPath,
      sessions
    }
  }
  return { id, label: GROUP_NAMES[id as keyof typeof GROUP_NAMES], sessions }
}

/** View membership and tool counts stay owned by the existing domain view. */
export function buildListGroups(
  sessions: readonly Session[],
  view: ViewId,
  filter: ToolFilter,
  grouping: Grouping
): ListGroup[] {
  const groups = buildView(sessions, view, filter).groups
  if (grouping === 'status') return groups.map((group) => listGroup(group.id, group.sessions))
  const projects = new Map<string, ListGroup>()
  for (const session of groups.flatMap((group) => group.sessions)) {
    const id = projectId(session)
    const group = projects.get(id) ?? listGroup(id)
    group.sessions.push(session)
    projects.set(id, group)
  }
  // Stable project ordering avoids rearranging the whole list on each activity update.
  return [...projects.values()]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((group) => ({ ...group, sessions: sortSessions(group.sessions, view !== 'pinned') }))
}
