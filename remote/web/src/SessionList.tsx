import { useId } from 'react'
import type { RemoteTool } from '../../../src/core/remote/share-policy'
import type { ViewerData } from './connection'
import {
  listView,
  omittedText,
  rowTime,
  sourceIssues,
  toolName,
  type Grouping,
  type ListChoices,
  type ListGroup,
  type Row
} from './status-view'

// The read-only session list (TASK-018), laid out like the desktop window's list column: a
// Group by switch (Status or Project), a tool filter with counts, then the groups. Rows are text:
// nothing here acts on a session, and the choices are page state only, so viewing, filtering and
// switching views send nothing to the Mac. Row keys are the Mac's opaque session IDs. Only while
// the Mac shares recent messages (TASK-033) is a row a button, and it only opens that session's
// recent messages on this page.

export interface SessionListProps {
  data: ViewerData
  choices: ListChoices
  onChoices: (choices: ListChoices) => void
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
  choices,
  onChoices,
  checkedAt,
  dimmed = false,
  onOpen,
  selected = null
}: SessionListProps) {
  const rowProps = { checkedAt, onOpen, selected }
  const { status } = data.frame
  const view = listView(status, choices)
  const issues = sourceIssues(status.sources)
  const omitted = omittedText(status.omitted)

  return (
    <div className={dimmed ? 'status dimmed' : 'status'} data-testid="status">
      {issues.map((issue) => (
        <p key={issue} className="source-issue">
          {issue}
        </p>
      ))}
      {status.projects.length === 0 ? (
        <p className="empty">
          No projects are shared. On the Mac, open AgentPeek → Settings → Remote View → Add Project.
        </p>
      ) : (
        <>
          <ListControls view={view} choices={choices} onChoices={onChoices} />
          {view.groups.map((group) => (
            <Group key={group.id} group={group} {...rowProps} />
          ))}
          {view.shown === 0 &&
            (choices.tool !== null && view.toolCounts.all > 0 ? (
              <section className="notice">
                <p>No sessions match this filter.</p>
                <button type="button" onClick={() => onChoices({ ...choices, tool: null })}>
                  Show all
                </button>
              </section>
            ) : choices.view === 'active' ? (
              <p className="empty">Nothing needs you right now.</p>
            ) : (
              <p className="empty">No sessions.</p>
            ))}
        </>
      )}
      {omitted && <p className="hint">{omitted}</p>}
    </div>
  )
}

const GROUPINGS: readonly { id: Grouping; label: string }[] = [
  { id: 'project', label: 'Project' },
  { id: 'status', label: 'Status' }
]

function ListControls({
  view,
  choices,
  onChoices
}: {
  view: ReturnType<typeof listView>
  choices: ListChoices
  onChoices: (choices: ListChoices) => void
}) {
  const groupLabel = useId()
  const tools: readonly { id: RemoteTool | null; label: string; count: number }[] = [
    { id: null, label: 'All', count: view.toolCounts.all },
    { id: 'codex', label: toolName('codex'), count: view.toolCounts.codex },
    { id: 'claude', label: toolName('claude'), count: view.toolCounts.claude }
  ]
  return (
    <div className="list-controls">
      <div className="group-by" role="group" aria-labelledby={groupLabel}>
        <span id={groupLabel} className="group-by-label">
          Group by
        </span>
        {GROUPINGS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            className="chip"
            aria-pressed={choices.grouping === id}
            onClick={() => onChoices({ ...choices, grouping: id })}
          >
            {label}
          </button>
        ))}
      </div>
      {view.toolChoices && (
        <div className="tool-filter" role="group" aria-label="Tool">
          {tools.map(({ id, label, count }) => (
            <button
              key={label}
              type="button"
              aria-pressed={choices.tool === id}
              aria-label={`${label}, ${count}`}
              onClick={() => onChoices({ ...choices, tool: id })}
            >
              <span aria-hidden="true">{label}</span>
              <span className="count" aria-hidden="true">
                {count}
              </span>
            </button>
          ))}
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

function Group({ group, ...rowProps }: RowProps & { group: ListGroup }) {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} className="group">
      <h2 id={headingId} className="group-heading">
        <span>{group.label}</span>
        {group.note && (
          <>
            <Sep />
            <span className="group-note">{group.note}</span>
          </>
        )}
      </h2>
      <ul className="rows">
        {group.rows.map((row) => (
          <SessionRow key={row.session.id} row={row} {...rowProps} />
        ))}
      </ul>
    </section>
  )
}

/** Hidden separators, so a screen reader reads "Session 1, Codex · web, Running, 2 min ago". */
const Sep = () => <span className="visually-hidden">, </span>

function SessionRow({ row, checkedAt, onOpen, selected }: RowProps & { row: Row }) {
  const time = rowTime(row, checkedAt)
  const content = (
    <>
      <span className="row-title">{row.session.title}</span>
      <Sep />
      <span className="row-meta">{`${toolName(row.session.tool)} · ${row.project}`}</span>
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
  const kind = `row kind-${row.kind}`
  if (!onOpen) return <li className={kind}>{content}</li>
  const id = row.session.id
  return (
    <li className="row-item">
      <button
        type="button"
        className={`${kind} row-button`}
        data-session={id}
        aria-current={selected === id ? 'true' : undefined}
        onClick={() => onOpen(id)}
      >
        {content}
      </button>
    </li>
  )
}
