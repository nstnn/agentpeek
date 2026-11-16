import { useId, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
import { sessionKeyToString, type Session, type SessionKey } from '../../core/session'
import { sortSessions } from '../../core/views'
import { rowStatus, sessionTitle, toolName, workspaceName } from './session-display'

export function QuickOpen({
  sessions,
  onClose,
  onOpen
}: {
  sessions: readonly Session[]
  onClose: () => void
  onOpen: (key: SessionKey) => void
}): JSX.Element {
  const id = useId()
  const dialog = useRef<HTMLDialogElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const matches = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
    return sortSessions(sessions, true).filter((session) => {
      const text = [
        sessionTitle(session),
        session.summary.workspacePath,
        session.key.id,
        toolName(session.key.tool)
      ]
        .join(' ')
        .toLowerCase()
      return words.every((word) => text.includes(word))
    })
  }, [sessions, query])
  const shown = matches.slice(0, 50)
  const index = Math.max(
    0,
    shown.findIndex((session) => sessionKeyToString(session.key) === selected)
  )
  const current = shown[index]
  const optionId = (session: Session) => `${id}-${sessionKeyToString(session.key)}`
  useLayoutEffect(() => {
    const element = dialog.current!
    const trigger = document.activeElement as HTMLElement | null
    element.showModal()
    input.current?.focus()
    return () => {
      element.close()
      if (trigger?.isConnected) trigger.focus({ preventScroll: true })
    }
  }, [])
  useLayoutEffect(() => {
    if (current) document.getElementById(optionId(current))?.scrollIntoView?.({ block: 'nearest' })
  })
  return (
    <dialog
      ref={dialog}
      className="quick-open"
      aria-labelledby={`${id}-title`}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      <div className="quick-open-heading">
        <h2 id={`${id}-title`}>Find Session</h2>
        <button type="button" aria-label="Close Find Session" onClick={onClose}>
          ×
        </button>
      </div>
      <input
        ref={input}
        role="combobox"
        aria-label="Find by title, folder or session ID"
        aria-autocomplete="list"
        aria-expanded="true"
        aria-controls={`${id}-results`}
        aria-activedescendant={current ? optionId(current) : undefined}
        placeholder="Title, folder or session ID…"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value)
          setSelected(null)
        }}
        onKeyDown={(event) => {
          if (
            ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) &&
            !event.metaKey &&
            !event.ctrlKey
          ) {
            event.preventDefault()
            const next =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? shown.length - 1
                  : (index + (event.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length
            if (shown[next]) setSelected(sessionKeyToString(shown[next].key))
          } else if (event.key === 'Enter') {
            event.preventDefault()
            if (current) onOpen(current.key)
          }
        }}
      />
      <div
        id={`${id}-results`}
        role="listbox"
        aria-label="Matching sessions"
        className="quick-open-results"
      >
        {shown.map((session, i) => (
          <button
            key={sessionKeyToString(session.key)}
            id={optionId(session)}
            type="button"
            role="option"
            aria-selected={i === index}
            tabIndex={-1}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onOpen(session.key)}
          >
            <strong>{sessionTitle(session)}</strong>
            <span>
              {toolName(session.key.tool)} · {workspaceName(session)} · {rowStatus(session).label}
              {session.pinned ? ' · Pinned' : ''}
            </span>
            <small>{session.summary.workspacePath ?? session.key.id}</small>
          </button>
        ))}
      </div>
      <p className="quick-open-hint" role="status">
        {matches.length === 0
          ? 'No matching sessions.'
          : `${matches.length} matching sessions${matches.length > shown.length ? ` · Showing first ${shown.length}; refine your search` : ''}.`}{' '}
        Searches loaded sessions from all views and tools.
      </p>
    </dialog>
  )
}
