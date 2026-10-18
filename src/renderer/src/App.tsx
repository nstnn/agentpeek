import { useEffect, useState, useSyncExternalStore, type JSX } from 'react'
import { buildView } from '../../core/views'
import { createSessionsStore, displayedGroups, sameKey, type SessionsStore } from './sessions-store'
import { VIEW_NAMES } from './session-display'
import { Sidebar, SessionBanners, EmptyList } from './session-panels'
import { SessionList } from './SessionList'

export function App({ store: suppliedStore }: { store?: SessionsStore }): JSX.Element {
  const [store] = useState(() => suppliedStore ?? createSessionsStore(window.agentpeek))
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const { snapshot, view, filter } = state
  const [now, setNow] = useState(Date.now)
  const [firstLaunchDismissed, dismissFirstLaunch] = useState(false)
  const [windowFocused, setWindowFocused] = useState(() => document.hasFocus())
  useEffect(() => {
    const focus = () => setWindowFocused(true)
    const blur = () => setWindowFocused(false)
    window.addEventListener('focus', focus)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('focus', focus)
      window.removeEventListener('blur', blur)
    }
  }, [])
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])
  const contents = buildView(snapshot?.sessions ?? [], view, filter)
  const groups = displayedGroups(state)
  const sessions = contents.groups.flatMap((group) => group.sessions)
  const attention = sessions.filter(
    (s) => s.attention.waiting || s.attention.error || s.attention.newReply
  ).length
  const running = sessions.filter((s) => s.activity.state === 'running').length
  const unknown = sessions.filter((s) => s.activity.state === 'unknown').length
  const selected = state.selection?.session
  const missing = selected && !snapshot?.sessions.some((s) => sameKey(s.key, selected.key))
  return (
    <div className="app-shell" data-window-focused={windowFocused}>
      <SessionBanners snapshot={snapshot} />
      <div className="workspace">
        <Sidebar snapshot={snapshot} view={view} onView={store.setView} />
        <main className="sessions-pane" aria-label="Sessions">
          <header className="list-header">
            <h1>{VIEW_NAMES[view]}</h1>
            <p className="summary">
              {attention} need attention · {running} running · {unknown} unknown
            </p>
            <div className="tool-filter" role="radiogroup" aria-label="Filter by tool">
              {(['all', 'codex', 'claude'] as const).map((tool) => (
                <button
                  key={tool}
                  type="button"
                  role="radio"
                  aria-checked={filter === tool}
                  tabIndex={filter === tool ? 0 : -1}
                  onClick={() => store.setFilter(tool)}
                  onKeyDown={(event) => {
                    const tools = ['all', 'codex', 'claude'] as const
                    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
                    event.preventDefault()
                    const index =
                      event.key === 'Home'
                        ? 0
                        : event.key === 'End'
                          ? 2
                          : (tools.indexOf(tool) + (event.key === 'ArrowRight' ? 1 : 2)) % 3
                    store.setFilter(tools[index]!)
                    event.currentTarget.parentElement?.querySelectorAll('button')[index]?.focus()
                  }}
                >
                  {tool === 'all' ? 'All' : tool === 'codex' ? 'Codex' : 'Claude Code'}{' '}
                  <span>{contents.toolCounts[tool]}</span>
                </button>
              ))}
            </div>
          </header>
          {snapshot?.firstLaunch && !firstLaunchDismissed && (
            <div className="strip info">
              <span>
                First launch: replies that finished before now count as read. New replies will show
                up here from now on.
              </span>
              <button
                type="button"
                aria-label="Dismiss first launch notice"
                onClick={() => dismissFirstLaunch(true)}
              >
                ×
              </button>
            </div>
          )}
          {state.actionError && (
            <p className="strip warning" role="status">
              {state.actionError}
            </p>
          )}
          {groups.length > 0 ? (
            <SessionList groups={groups} state={state} store={store} now={now} />
          ) : (
            <EmptyList state={state} onShowAll={() => store.setView('all')} />
          )}
          {view === 'all' && (
            <p className="footnote">
              Sessions active in the last 7 days (up to 50 per tool), plus every session that is
              running or waiting.
            </p>
          )}
        </main>
        <aside className="detail-placeholder" aria-label="Session detail">
          <h2>{selected ? 'Session detail comes next' : 'No session selected'}</h2>
          <p>
            {selected
              ? missing
                ? 'This session is no longer available.'
                : 'The latest exchange will be available here in a future update.'
              : 'Select a session to see its latest exchange.'}
          </p>
        </aside>
      </div>
    </div>
  )
}
