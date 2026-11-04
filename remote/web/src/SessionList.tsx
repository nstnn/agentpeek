import { useId } from 'react'
import type { AgentTool } from '../../../src/core/tools'
import type { ViewerData } from './connection'
import {
  NO_FILTERS,
  omittedText,
  rowTime,
  sourceIssues,
  statusView,
  toolName,
  type Filters,
  type Row
} from './status-view'

// The read-only session list (TASK-018). Rows are text: nothing here acts on a session, and the
// filters are page state only, so viewing, filtering and switching projects send nothing to the
// Mac. Row keys are the Mac's opaque session IDs. Only while the Mac shares recent messages
// (TASK-033) is a row a button, and it only opens that session's recent messages on this page.

export interface SessionListProps {
  data: ViewerData
  filters: Filters
  onFilters: (filters: Filters) => void
  /** The Mac's time the ages are measured to (see App). */
  checkedAt: number
  /** Data kept from before a drop; the header says "showing data from <time>". */
  dimmed?: boolean
  /** Set while the Mac shares recent messages: rows become buttons that open them. */
  onOpen?: (session: string) => void
  /** The session whose recent messages are open. */
  selected?: string | null
}

export function SessionList({
  data,
  filters,
  onFilters,
  checkedAt,
  dimmed = false,
  onOpen,
  selected = null
}: SessionListProps) {
  const rowProps = { checkedAt, onOpen, selected }
  const { status } = data.frame
  const view = statusView(status, filters)
  const filtered = view.filters.project !== null || view.filters.tool !== null
  const issues = sourceIssues(status.sources)
  const omitted = omittedText(status.omitted)
  const shown = view.attention.length + view.projects.reduce((n, p) => n + p.rows.length, 0)
  const anyAttention = view.counts.waiting + view.counts.error + view.counts.reply > 0

  return (
    <div className={dimmed ? 'status dimmed' : 'status'} data-testid="status">
      {issues.map((issue) => (
        <p key={issue} className="source-issue">
          {issue}
        </p>
      ))}
      {status.projects.length === 0 ? (
        <p>
          No projects are shared. On the Mac, open AgentPeek → Settings → Remote View → Add Project.
        </p>
      ) : (
        <>
          <FilterBar view={view} onFilters={onFilters} />
          {!anyAttention && <p className="all-clear">Nothing needs you right now.</p>}
          {view.attention.length > 0 && (
            <Group title="Needs attention" rows={view.attention} {...rowProps} withProject />
          )}
          {view.projects.map((project) =>
            project.rows.length > 0 ? (
              <Group key={project.label} title={project.label} rows={project.rows} {...rowProps} />
            ) : filtered ? null : (
              <section key={project.label} aria-label={project.label}>
                <h2>{project.label}</h2>
                <p className="hint">
                  {project.total === 0 ? 'No sessions.' : 'No other sessions.'}
                </p>
              </section>
            )
          )}
          {filtered && shown === 0 && (
            <section className="notice">
              <p>No sessions match these filters.</p>
              <button type="button" onClick={() => onFilters(NO_FILTERS)}>
                Show all
              </button>
            </section>
          )}
        </>
      )}
      {omitted && <p className="hint">{omitted}</p>}
    </div>
  )
}

function FilterBar({
  view,
  onFilters
}: {
  view: ReturnType<typeof statusView>
  onFilters: (filters: Filters) => void
}) {
  const projectId = useId()
  const toolId = useId()
  if (view.projectChoices.length === 0 && view.toolChoices.length === 0) return null
  const { filters } = view
  return (
    <div className="filters" role="group" aria-label="Filter sessions">
      {view.projectChoices.length > 0 && (
        <div className="filter">
          <label htmlFor={projectId}>Project</label>
          <select
            // Prevent browser session restoration from persisting a selected project label.
            autoComplete="off"
            id={projectId}
            value={filters.project ?? ''}
            onChange={(event) => onFilters({ ...filters, project: event.target.value || null })}
          >
            <option value="">All projects</option>
            {view.projectChoices.map((label) => (
              <option key={label} value={label}>
                {label}
              </option>
            ))}
          </select>
        </div>
      )}
      {view.toolChoices.length > 0 && (
        <div className="filter">
          <label htmlFor={toolId}>Tool</label>
          <select
            // Prevent browser session restoration from persisting a selected project label.
            autoComplete="off"
            id={toolId}
            value={filters.tool ?? ''}
            onChange={(event) =>
              onFilters({ ...filters, tool: (event.target.value || null) as AgentTool | null })
            }
          >
            <option value="">All tools</option>
            {view.toolChoices.map((tool) => (
              <option key={tool} value={tool}>
                {toolName(tool)}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  )
}

type RowProps = {
  checkedAt: number
  onOpen?: (session: string) => void
  selected?: string | null
}

function Group({
  title,
  rows,
  withProject = false,
  ...rowProps
}: RowProps & {
  title: string
  rows: Row[]
  withProject?: boolean
}) {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId}>
      <h2 id={headingId}>{title}</h2>
      <ul className="rows">
        {rows.map((row) => (
          <SessionRow key={row.session.id} row={row} withProject={withProject} {...rowProps} />
        ))}
      </ul>
    </section>
  )
}

/** Hidden separators, so a screen reader reads "Session 1, Codex, Running, 2 min ago". */
const Sep = () => <span className="visually-hidden">, </span>

function SessionRow({
  row,
  checkedAt,
  withProject,
  onOpen,
  selected
}: RowProps & {
  row: Row
  withProject: boolean
}) {
  const time = rowTime(row, checkedAt)
  const meta = withProject
    ? `${toolName(row.session.tool)} · ${row.project}`
    : toolName(row.session.tool)
  const content = (
    <>
      <span className="row-title">{row.session.title}</span>
      <Sep />
      <span className="row-meta">{meta}</span>
      <Sep />
      <span className={`row-state state-${row.kind}`}>{row.label}</span>
      {time && (
        <>
          <Sep />
          <time className="row-time" dateTime={new Date(time.at).toISOString()}>
            {time.text}
          </time>
        </>
      )}
    </>
  )
  if (!onOpen) return <li className="row">{content}</li>
  const id = row.session.id
  return (
    <li className="row-item">
      <button
        type="button"
        className="row row-button"
        data-session={id}
        aria-current={selected === id ? 'true' : undefined}
        onClick={() => onOpen(id)}
      >
        {content}
      </button>
    </li>
  )
}
