import { useLayoutEffect, useRef, type JSX } from 'react'
import type { AppSnapshot } from '../../shared/api'
import { AGENT_TOOLS } from '../../core/tools'
import type { ViewId } from '../../core/views'
import type { RendererState } from './sessions-store'
import { healthCopy, toolHome, toolName, VIEW_NAMES } from './session-display'

export function Sidebar({
  snapshot,
  view,
  onView
}: {
  snapshot: AppSnapshot | null
  view: ViewId
  onView: (view: ViewId) => void
}): JSX.Element {
  const views = ['active', 'pinned', 'all'] as const
  return (
    <aside className="sidebar" aria-label="Session navigation and sources">
      <h2>Sessions</h2>
      <nav aria-label="Session views">
        {views.map((id) => {
          const count =
            id === 'active' ? (snapshot?.needsAttention ?? 0) : (snapshot?.groupCounts[id] ?? 0)
          return (
            <button
              key={id}
              type="button"
              aria-label={`${VIEW_NAMES[id]}${id !== 'active' || count > 0 ? ` ${count}` : ''}`}
              aria-current={view === id ? 'page' : undefined}
              tabIndex={view === id ? 0 : -1}
              onClick={() => onView(id)}
              onKeyDown={(event) => {
                if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
                event.preventDefault()
                const index =
                  event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? 2
                      : (views.indexOf(id) + (event.key === 'ArrowDown' ? 1 : 2)) % 3
                onView(views[index]!)
                event.currentTarget.parentElement?.querySelectorAll('button')[index]?.focus()
              }}
            >
              <span>{VIEW_NAMES[id]}</span>
              {(id !== 'active' || count > 0) && (
                <span className={id === 'active' ? 'badge' : 'count'}>{count}</span>
              )}
            </button>
          )
        })}
      </nav>
      <h2 className="sources-heading">Sources</h2>
      {AGENT_TOOLS.map((tool) => {
        const health = snapshot?.health[tool] ?? { state: 'checking' }
        const copy = healthCopy(tool, health)
        return (
          <section key={tool} className="source" aria-label={`${toolName(tool)} source`}>
            <h3>{toolName(tool)}</h3>
            <p>
              <span className={`health-dot ${health.state}`} aria-hidden="true" />
              {copy.label}
            </p>
            <p className="source-detail">{copy.detail}</p>
          </section>
        )
      })}
    </aside>
  )
}

export function ReloadSessions({
  pending,
  onReload
}: {
  pending: boolean
  onReload: () => Promise<void>
}): JSX.Element {
  const button = useRef<HTMLButtonElement>(null)
  useLayoutEffect(
    () => () => {
      if (document.activeElement !== button.current) return
      // Source recovery may arrive after reload() completes. Restore focus when its control
      // actually leaves the page, without stealing focus from a later user selection.
      queueMicrotask(() => {
        if (document.activeElement !== document.body) return
        const target =
          document.querySelector<HTMLElement>('.detail-pane:not([hidden]) .transcript') ??
          document.querySelector<HTMLElement>('[role=listbox]:not([hidden])')
        target?.focus({ preventScroll: true })
      })
    },
    []
  )
  return (
    <button
      ref={button}
      type="button"
      aria-label="Reload Sessions"
      aria-disabled={pending}
      onClick={() => {
        if (pending) return
        void onReload()
      }}
    >
      {pending ? 'Reloading…' : 'Reload Sessions'}
    </button>
  )
}

export function SessionBanners({
  snapshot,
  reloadPending,
  reloadError,
  onReload
}: {
  snapshot: AppSnapshot | null
  reloadPending: boolean
  reloadError: string | null
  onReload: () => Promise<void>
}): JSX.Element {
  return (
    <>
      {snapshot?.fixture && (
        <p className="banner fixture-banner">
          Fixture data · AgentPeek is showing synthetic sessions from {snapshot.fixtureHome}, not
          your real sessions.
        </p>
      )}
      {snapshot?.localState.kind === 'unavailable' && (
        <p className="banner warning">
          Pins and read markers won't be saved.{' '}
          {snapshot.localState.reason === 'unwritable' ? (
            "AgentPeek can't save its state file."
          ) : (
            <>
              AgentPeek's saved state{' '}
              {snapshot.localState.reason === 'newer-version'
                ? 'was made by a newer version'
                : "can't be read"}
              , so it was left unchanged.
            </>
          )}{' '}
          Changes you make now last until you quit.
        </p>
      )}
      {AGENT_TOOLS.map((tool) => {
        const health = snapshot?.health[tool]
        if (health?.state === 'no-access')
          return (
            <div className="banner warning source-warning" key={tool}>
              <span>
                Can't read {toolName(tool)} files. AgentPeek doesn't have permission to read{' '}
                {toolHome(tool)}. It only reads these files and never changes them.
              </span>{' '}
              <ReloadSessions pending={reloadPending} onReload={onReload} />
            </div>
          )
        if (health?.state === 'unsupported')
          return (
            <p className="banner warning" key={tool}>
              {toolName(tool)} {health.toolVersion ?? '(unknown version)'} writes its files in a
              format AgentPeek doesn't recognize. Its sessions show as Unknown.
            </p>
          )
        return null
      })}
      {reloadError && (
        <p className="banner warning" role="status">
          {reloadError}
        </p>
      )}
    </>
  )
}

export function EmptyList({
  state,
  onShowAll
}: {
  state: RendererState
  onShowAll: () => void
}): JSX.Element {
  const { snapshot, view, filter } = state
  let title: string
  let body: string
  const health = filter === 'all' ? null : snapshot?.health[filter]
  const checking =
    !snapshot || AGENT_TOOLS.every((tool) => snapshot.health[tool].state === 'checking')
  if (state.failed && !snapshot) {
    title = "Couldn't load sessions"
    body = 'Choose View > Reload Sessions to try again.'
  } else if (checking || health?.state === 'checking') {
    title = 'Reading sessions…'
    body = 'Checking Codex and Claude Code files on this Mac. AgentPeek only reads them.'
  } else if (filter !== 'all' && health?.state === 'not-installed') {
    title = `${toolName(filter)} isn't installed`
    body = `AgentPeek looks for ${toolName(filter)} files in ${toolHome(filter)}. If you install ${toolName(filter)}, choose View > Reload Sessions.`
  } else if (filter !== 'all' && health?.state === 'no-access') {
    title = `Can't read ${toolName(filter)} files`
    body = `AgentPeek doesn't have permission to read ${toolHome(filter)}. It only reads these files and never changes them. Choose View > Reload Sessions to try again.`
  } else if (filter !== 'all' && health?.state === 'unsupported') {
    title = 'Unsupported format'
    body = `${toolName(filter)} ${health.toolVersion ?? '(unknown version)'} writes its files in a format AgentPeek doesn't recognize. Its sessions show as Unknown.`
  } else if (view === 'pinned') {
    title = 'No pinned sessions'
    body = 'Pin a session to keep it here (⇧⌘P).'
  } else if (view === 'all' || snapshot?.sessions.length === 0) {
    title = 'No sessions yet'
    body =
      'Start a conversation in Codex or Claude Code and it will show up here. AgentPeek lists sessions from the last 7 days.'
  } else {
    title = 'Nothing needs you right now'
    body = 'No session is running, waiting for you, or has a new reply.'
  }
  return (
    <div className="empty-list">
      <h2>{title}</h2>
      <p>{body}</p>
      {title === 'Nothing needs you right now' && (
        <button type="button" onClick={onShowAll}>
          Show All Sessions
        </button>
      )}
    </div>
  )
}
