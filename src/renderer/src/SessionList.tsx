import { useState, type JSX } from 'react'
import { flushSync } from 'react-dom'
import { sessionKeyToString, type Session } from '../../core/session'
import { buildView, type SessionGroup } from '../../core/views'
import { sameKey, type RendererState, type SessionsStore } from './sessions-store'
import {
  GROUP_NAMES,
  relativeTime,
  rowStatus,
  sessionTitle,
  toolName,
  workspaceName
} from './session-display'
import { SessionIcon } from './SessionIcon'
import { useListAnchor } from './use-list-anchor'

export function SessionList({
  groups,
  state,
  store,
  now,
  hidden = false,
  onSessionDrag,
  onSessionDragEnd
}: {
  groups: SessionGroup[]
  state: RendererState
  store: SessionsStore
  now: number
  hidden?: boolean
  onSessionDrag: (session: Session) => void
  onSessionDragEnd: () => void
}): JSX.Element {
  const [contextKey, setContextKey] = useState<string | null>(null)
  const rows = groups.flatMap((g) => g.sessions)
  const counts = buildView(state.snapshot?.sessions ?? [], state.view, state.filter).groups
  const selected = state.listSelection?.session
  const selectedId = selected ? sessionKeyToString(selected.key) : null
  const {
    list,
    head,
    tail,
    remember: rememberScroll
  } = useListAnchor(selectedId, state.snapshot, hidden)
  const openContextMenu = async (session: Session) => {
    // Commit before the native popup can suspend renderer painting.
    flushSync(() => setContextKey(sessionKeyToString(session.key)))
    try {
      await window.agentpeek.showSessionMenu(session.key)
    } catch {
      store.reportActionError()
    } finally {
      setContextKey(null)
    }
  }
  return (
    <div
      className="list-scroll"
      role="listbox"
      aria-label={`${state.view === 'all' ? 'All' : state.view === 'pinned' ? 'Pinned' : 'Active'} sessions`}
      tabIndex={0}
      ref={list}
      hidden={hidden}
      onScroll={rememberScroll}
      aria-live="off"
      aria-activedescendant={selectedId ? `session-${selectedId}` : undefined}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && selected) {
          event.preventDefault()
          store.activate(selected, groups)
        }
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault()
          const index = rows.findIndex((s) => selected && sameKey(s.key, selected.key))
          const next =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? rows.length - 1
                : index < 0
                  ? event.key === 'ArrowDown'
                    ? 0
                    : rows.length - 1
                  : Math.max(
                      0,
                      Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1))
                    )
          const session = rows[next]
          if (session) {
            store.select(session, groups)
            document
              .getElementById(`session-${sessionKeyToString(session.key)}`)
              ?.scrollIntoView({ block: 'nearest' })
          }
        }
        if ((event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) && selected) {
          event.preventDefault()
          void openContextMenu(selected)
        }
      }}
    >
      <div ref={head} aria-hidden="true" />
      {groups.map((group) => (
        <div role="group" aria-labelledby={`group-${group.id}`} key={group.id}>
          <h2 className="group-heading" id={`group-${group.id}`}>
            <span>{GROUP_NAMES[group.id]}</span>
            <span>
              {counts.find((g) => g.id === group.id)?.sessions.length ?? 0}{' '}
              {['waiting', 'errors', 'new-replies'].includes(group.id) ? 'outstanding' : 'current'}
            </span>
          </h2>
          {group.sessions.map((session) => {
            const id = sessionKeyToString(session.key)
            const missing = !state.snapshot?.sessions.some((s) => sameKey(s.key, session.key))
            const status = rowStatus(session, missing)
            const title = sessionTitle(session)
            const time = relativeTime(session.summary.lastActivityAt, now)
            const active = id === selectedId
            const inSecond =
              !!state.secondarySelection &&
              sameKey(state.secondarySelection.session.key, session.key) &&
              counts.some((g) => g.sessions.some((s) => sameKey(s.key, session.key)))
            const retained =
              active &&
              !counts
                .find((g) => g.id === group.id)
                ?.sessions.some((s) => sameKey(s.key, session.key))
            const label = `${title}, ${toolName(session.key.tool)}, ${workspaceName(session)}, ${status.label}, ${time}${session.pinned ? ', pinned' : ''}${retained ? ', kept here while selected' : ''}${inSecond ? ', Right pane' : ''}`
            return (
              <div
                key={id}
                id={`session-${id}`}
                role="option"
                aria-selected={active}
                aria-label={label}
                className={`session-row${active ? ' selected' : ''}${contextKey === id ? ' context-open' : ''}`}
                draggable={!missing}
                onDragStart={(event) => {
                  if (missing) {
                    event.preventDefault()
                    return
                  }
                  event.dataTransfer.effectAllowed = 'copy'
                  event.dataTransfer.setData('application/x-agentpeek-session', id)
                  // Live regrouping can detach the origin before dragend reaches React's root.
                  event.currentTarget.addEventListener('dragend', onSessionDragEnd, { once: true })
                  // Paint and install drop targets before the native drag loop takes over.
                  flushSync(() => onSessionDrag(session))
                }}
                onClick={() => {
                  store.activate(session, groups)
                  if (!list.current?.closest('[hidden]')) list.current?.focus()
                }}
                onContextMenu={(event) => {
                  event.preventDefault()
                  list.current?.focus()
                  void openContextMenu(session)
                }}
              >
                <span
                  className={`unread-dot${session.attention.newReply ? ' visible' : ''}`}
                  aria-hidden="true"
                />
                <div className="row-line">
                  <span className="row-title" title={title}>
                    {title}
                  </span>
                  {session.pinned && (
                    <span className="pin" aria-hidden="true">
                      <SessionIcon kind="pin" />
                    </span>
                  )}
                  <time
                    className="row-time"
                    dateTime={new Date(session.summary.lastActivityAt).toISOString()}
                  >
                    {time}
                  </time>
                </div>
                <div className="row-line row-secondary">
                  <span className="row-meta" title={session.summary.workspacePath ?? 'No folder'}>
                    {toolName(session.key.tool)} · {workspaceName(session)}
                  </span>
                  <span className={`row-status ${status.kind}`}>
                    <span className="status-icon" aria-hidden="true">
                      <SessionIcon kind={status.kind} />
                    </span>
                    {status.label}
                  </span>
                </div>
                {retained && <span className="row-retained">Kept here while selected.</span>}
                {inSecond && <span className="row-second">Right pane</span>}
              </div>
            )
          })}
        </div>
      ))}
      <div ref={tail} aria-hidden="true" />
    </div>
  )
}
