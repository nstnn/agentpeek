import { useState, type JSX } from 'react'
import { flushSync } from 'react-dom'
import { sessionKeyToString, type Session } from '../../core/session'
import type { ListGroup } from './list-groups'
import { currentGroups, sameKey, type RendererState, type SessionsStore } from './sessions-store'
import { relativeTime, rowStatus, sessionTitle, toolName, workspaceName } from './session-display'
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
  groups: ListGroup[]
  state: RendererState
  store: SessionsStore
  now: number
  hidden?: boolean
  onSessionDrag: (session: Session) => void
  onSessionDragEnd: () => void
}): JSX.Element {
  const [contextKey, setContextKey] = useState<string | null>(null)
  const projectMode = state.grouping === 'project'
  const counts = currentGroups(state)
  const collapsed = (group: ListGroup) => projectMode && state.collapsedProjects.includes(group.id)
  const groupId = (group: ListGroup) => `group-${encodeURIComponent(group.id)}`
  const projectLabel = (group: ListGroup) =>
    groups.some((other) => other.id !== group.id && other.label === group.label)
      ? (group.projectPath ?? group.label)
      : group.label
  const focusedGroup = projectMode
    ? groups.find((group) => group.id === state.focusedProject)
    : undefined
  const nodes = groups.flatMap((group) => [
    ...(projectMode ? [{ id: groupId(group), group, session: null }] : []),
    ...(collapsed(group)
      ? []
      : group.sessions.map((session) => ({
          id: `session-${sessionKeyToString(session.key)}`,
          group,
          session
        })))
  ])
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
  const renderRows = (group: ListGroup) =>
    group.sessions.map((session) => {
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
        !counts.find((g) => g.id === group.id)?.sessions.some((s) => sameKey(s.key, session.key))
      const label = `${title}, ${toolName(session.key.tool)}, ${workspaceName(session)}, ${status.label}, ${time}${session.pinned ? ', pinned' : ''}${retained ? ', kept here while selected' : ''}${inSecond ? ', Right pane' : ''}`
      return (
        <div
          key={id}
          id={`session-${id}`}
          role={projectMode ? 'treeitem' : 'option'}
          aria-level={projectMode ? 2 : undefined}
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
              {toolName(session.key.tool)}
              {!projectMode && ` · ${workspaceName(session)}`}
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
    })
  return (
    <div
      className="list-scroll"
      role={projectMode ? 'tree' : 'listbox'}
      aria-label={`${state.view === 'all' ? 'All' : state.view === 'pinned' ? 'Pinned' : 'Active'} sessions`}
      tabIndex={0}
      ref={list}
      hidden={hidden}
      onScroll={rememberScroll}
      aria-live="off"
      aria-activedescendant={
        focusedGroup ? groupId(focusedGroup) : selectedId ? `session-${selectedId}` : undefined
      }
      onKeyDown={(event) => {
        const currentId = focusedGroup
          ? groupId(focusedGroup)
          : selectedId
            ? `session-${selectedId}`
            : null
        const current = nodes.find((node) => node.id === currentId)
        const moveTo = (node: typeof current) => {
          if (!node) return
          if (node.session) store.select(node.session, groups)
          else store.focusProject(node.group.id)
          document.getElementById(node.id)?.scrollIntoView({ block: 'nearest' })
        }
        if (event.key === 'Enter' || (event.key === ' ' && projectMode)) {
          event.preventDefault()
          if (focusedGroup) store.toggleProject(focusedGroup.id)
          else if (selected) store.activate(selected, groups)
        }
        if (projectMode && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
          event.preventDefault()
          if (current) {
            if (current.session && event.key === 'ArrowLeft') store.focusProject(current.group.id)
            else if (!current.session) {
              if (
                (event.key === 'ArrowLeft' && !collapsed(current.group)) ||
                (event.key === 'ArrowRight' && collapsed(current.group))
              )
                store.toggleProject(current.group.id)
              else if (event.key === 'ArrowRight')
                moveTo(nodes.find((node) => node.group === current.group && node.session))
            }
          }
        }
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault()
          const index = nodes.findIndex((node) => node.id === currentId)
          const next =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? nodes.length - 1
                : index < 0
                  ? event.key === 'ArrowDown'
                    ? 0
                    : nodes.length - 1
                  : Math.max(
                      0,
                      Math.min(nodes.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1))
                    )
          moveTo(nodes[next])
        }
        if (
          (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) &&
          selected &&
          !focusedGroup
        ) {
          event.preventDefault()
          void openContextMenu(selected)
        }
      }}
    >
      <div ref={head} aria-hidden="true" />
      {groups.map((group) => {
        const members = counts.find((g) => g.id === group.id)?.sessions ?? []
        const attention = members.filter(
          (s) => s.attention.waiting || s.attention.error || s.attention.newReply
        ).length
        const running = members.filter((s) => s.activity.state === 'running').length
        const summary = `${members.length} ${members.length === 1 ? 'session' : 'sessions'}${attention ? ` · ${attention} need attention` : ''}${running ? ` · ${running} running` : ''}`
        return projectMode ? (
          <div
            key={group.id}
            role="treeitem"
            id={groupId(group)}
            aria-label={`${projectLabel(group)}, ${group.projectPath ?? 'No folder'}, ${summary}`}
            aria-expanded={!collapsed(group)}
            aria-level={1}
            className="project-group"
          >
            <div
              className={`project-heading${focusedGroup?.id === group.id ? ' focused' : ''}`}
              title={group.projectPath ?? 'No folder'}
              onClick={() => {
                store.toggleProject(group.id)
                list.current?.focus()
              }}
            >
              <span className="project-chevron" aria-hidden="true">
                {collapsed(group) ? '▸' : '▾'}
              </span>
              <span className="project-name">{projectLabel(group)}</span>
              <span className="project-count">{members.length}</span>
              {(attention > 0 || running > 0) && (
                <span className="project-summary">
                  {attention > 0 && (
                    <span className="project-attention">{attention} need attention</span>
                  )}
                  {running > 0 && <span>{running} running</span>}
                </span>
              )}
            </div>
            <div role="group" hidden={collapsed(group)}>
              {renderRows(group)}
            </div>
          </div>
        ) : (
          <div role="group" aria-labelledby={groupId(group)} key={group.id}>
            <h2 className="group-heading" id={groupId(group)}>
              <span>{group.label}</span>
              <span>
                {members.length}{' '}
                {['waiting', 'errors', 'new-replies'].includes(group.id)
                  ? 'outstanding'
                  : 'current'}
              </span>
            </h2>
            {renderRows(group)}
          </div>
        )
      })}
      <div ref={tail} aria-hidden="true" />
    </div>
  )
}
