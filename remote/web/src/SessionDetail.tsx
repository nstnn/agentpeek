import { useEffect, useId, useRef } from 'react'
import type { MessageEntry } from '../../../src/core/remote/protocol'
import type { RemoteSession } from '../../../src/core/remote/status-projection'
import type { DetailView } from './details'
import { InertMarkdown } from './InertMarkdown'
import { toolName } from './status-view'

// One session's recent messages (TASK-033). Read-only: viewing sends one GET for the messages and
// nothing else, so it never marks a reply read, acknowledges an error or selects anything on the
// Mac. The text comes from the detail state in memory only.

export interface SessionDetailProps {
  /** The row from the last status, or null when the status no longer lists the session. */
  session: RemoteSession | null
  project: string | null
  view: DetailView
  onBack: () => void
  onRetry: () => void
}

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })

export function SessionDetail({ session, project, view, onBack, onRetry }: SessionDetailProps) {
  const headingId = useId()
  const heading = useRef<HTMLHeadingElement>(null)
  // Opening a detail moves focus to its heading, so keyboard and screen-reader users land there.
  useEffect(() => heading.current?.focus(), [session?.id])

  return (
    <section className="detail" aria-labelledby={headingId} data-testid="detail">
      <button type="button" className="back" onClick={onBack}>
        Back to sessions
      </button>
      <h2 id={headingId} ref={heading} tabIndex={-1}>
        {session?.title ?? 'Session'}
      </h2>
      {session && (
        <p className="row-meta">
          {project ? `${toolName(session.tool)} · ${project}` : toolName(session.tool)}
        </p>
      )}
      <DetailBody view={view} onRetry={onRetry} />
    </section>
  )
}

function DetailBody({ view, onRetry }: { view: DetailView; onRetry: () => void }) {
  switch (view.kind) {
    case 'loading':
      return <p className="hint">Loading recent messages…</p>
    case 'paused':
      return <p className="hint">Recent messages come back when the connection does.</p>
    case 'not-shared':
      return (
        <>
          <p>Recent messages are not shared.</p>
          <p className="hint">
            On the Mac, open AgentPeek → Settings → Remote View → Share recent messages.
          </p>
        </>
      )
    case 'unavailable':
      return <p>{UNAVAILABLE[view.reason]}</p>
    case 'failed':
      return (
        <>
          <p>Couldn’t load recent messages.</p>
          <button type="button" onClick={onRetry}>
            Retry
          </button>
        </>
      )
    case 'messages':
      return (
        <>
          {view.older && <p className="hint">Only the latest messages are shown.</p>}
          <ol className="messages">
            {view.entries.map((entry, index) => (
              <Entry key={`${entry.at}-${index}`} entry={entry} />
            ))}
          </ol>
        </>
      )
  }
}

const UNAVAILABLE = {
  gone: 'Unavailable.',
  unreadable: 'These messages can’t be read on the Mac right now.',
  unsupported: 'Recent messages aren’t supported for this session.',
  empty: 'No messages yet.'
} as const

function Entry({ entry }: { entry: MessageEntry }) {
  const at = <time dateTime={new Date(entry.at).toISOString()}>{timeFormat.format(entry.at)}</time>
  if (entry.kind === 'tool-calls') {
    return (
      <li className="entry entry-tools">
        <span>{entry.count === 1 ? '1 tool call' : `${entry.count} tool calls`}</span> · {at}
      </li>
    )
  }
  return (
    <li className={`entry entry-${entry.kind}`}>
      <p className="entry-meta">
        <span className="entry-who">{entry.kind === 'prompt' ? 'You' : 'Agent'}</span> · {at}
      </p>
      <InertMarkdown text={entry.text} />
      {entry.cut && <p className="hint">Shortened to fit.</p>}
    </li>
  )
}
