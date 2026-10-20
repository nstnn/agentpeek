import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type JSX } from 'react'
import { sessionKeyToString } from '../../core/session'
import { flushSync } from 'react-dom'
import { buildView } from '../../core/views'
import { createSessionsStore, displayedGroups, sameKey, type SessionsStore } from './sessions-store'
import { VIEW_NAMES } from './session-display'
import { Sidebar, SessionBanners, EmptyList } from './session-panels'
import { SessionList } from './SessionList'
import { SessionDetail } from './SessionDetail'

export function App({ store: suppliedStore }: { store?: SessionsStore }): JSX.Element {
  const [store] = useState(() => suppliedStore ?? createSessionsStore(window.agentpeek))
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const { snapshot, view, filter } = state
  const [now, setNow] = useState(Date.now)
  const [firstLaunchDismissed, dismissFirstLaunch] = useState(false)
  const [windowFocused, setWindowFocused] = useState(() => document.hasFocus())
  const [roomy, setRoomy] = useState(() => window.matchMedia('(min-width: 1300px)').matches)
  const mainPane = useRef<HTMLElement>(null)
  const secondPane = useRef<HTMLElement>(null)
  const navigation = useRef<HTMLElement>(null)
  const previousSecond = useRef<string | null>(null)
  const previousPlacement = useRef(0)
  const wasSecondVisible = useRef(false)
  const wasDetailOpen = useRef(false)
  const split = !!state.secondarySelection
  const detailVisible = !state.narrow || state.detailOpen
  // Compact split navigation is delivered separately. Until then, only the roomy
  // composition presents Second; hidden details retain state without requesting text.
  const secondVisible = split && roomy && detailVisible
  useLayoutEffect(() => {
    const media = window.matchMedia('(min-width: 1300px)')
    const change = () => setRoomy(media.matches)
    change()
    media.addEventListener('change', change)
    return () => media.removeEventListener('change', change)
  }, [])
  useLayoutEffect(() => {
    const media = window.matchMedia('(max-width: 999px)')
    const update = () => store.setNarrow(media.matches)
    const change = () => flushSync(update)
    update()
    media.addEventListener('change', change)
    return () => media.removeEventListener('change', change)
  }, [store])
  useLayoutEffect(() => {
    if (state.detailOpen && !wasDetailOpen.current)
      mainPane.current?.querySelector<HTMLButtonElement>('.detail-back')?.focus()
    if (!state.detailOpen && wasDetailOpen.current)
      navigation.current
        ?.querySelector<HTMLElement>('[role=listbox]')
        ?.focus({ preventScroll: true })
    wasDetailOpen.current = state.detailOpen
  }, [state.detailOpen])
  useLayoutEffect(() => {
    store.setVisiblePanes(detailVisible ? (secondVisible ? ['main', 'second'] : ['main']) : [])
  }, [store, detailVisible, secondVisible])
  const secondKey = state.secondarySelection
    ? sessionKeyToString(state.secondarySelection.session.key)
    : null
  useLayoutEffect(() => {
    const placed = previousPlacement.current !== state.secondaryOpenVersion
    const revealed = secondVisible && !wasSecondVisible.current
    if (secondKey && secondVisible && state.activePane === 'second' && (placed || revealed)) {
      // Placement (including reopening the same key) focuses the region, while
      // ordinary snapshots and focus within its controls leave focus untouched.
      if (!secondPane.current?.contains(document.activeElement))
        secondPane.current?.focus({ preventScroll: true })
    } else if (previousSecond.current && !secondKey) {
      if (state.selection && detailVisible) mainPane.current?.focus({ preventScroll: true })
      else navigation.current?.querySelector<HTMLElement>('[role=listbox]')?.focus()
    }
    previousSecond.current = secondKey
    previousPlacement.current = state.secondaryOpenVersion
    wasSecondVisible.current = secondVisible
  }, [
    secondKey,
    secondVisible,
    state.activePane,
    state.secondaryOpenVersion,
    state.selection,
    detailVisible
  ])
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
  return (
    <div
      className="app-shell"
      data-window-focused={windowFocused}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && state.detailOpen) {
          event.preventDefault()
          store.back()
        }
      }}
    >
      <SessionBanners
        snapshot={snapshot}
        reloadPending={state.reloadPending}
        reloadError={state.reloadError}
        onReload={store.reload}
      />
      <div className={`workspace${secondVisible ? ' split-workspace' : ''}`}>
        <Sidebar snapshot={snapshot} view={view} onView={store.setView} />
        <main
          className="sessions-pane"
          ref={navigation}
          aria-label="Sessions"
          hidden={state.narrow && state.detailOpen}
        >
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
            <SessionList
              groups={groups}
              state={state}
              store={store}
              now={now}
              hidden={state.narrow && state.detailOpen}
            />
          ) : (
            <EmptyList
              state={state}
              unfilteredCount={contents.toolCounts.all}
              onShowAll={() => {
                store.setView('all')
                document
                  .querySelector<HTMLButtonElement>('.tool-filter [aria-checked=true]')
                  ?.focus()
              }}
              onClearFilter={() => {
                store.setFilter('all')
                document.querySelector<HTMLButtonElement>('.tool-filter [role=radio]')?.focus()
              }}
            />
          )}
          {view === 'all' && (
            <p className="footnote">
              Sessions active in the last 7 days (up to 50 per tool), plus every session that is
              running or waiting.
            </p>
          )}
        </main>
        {(['main', 'second'] as const).map((pane) => {
          const selection = pane === 'main' ? state.selection : state.secondarySelection
          if (pane === 'second' && !selection) return null
          const selected = selection?.session
          const visible = pane === 'main' ? detailVisible : secondVisible
          const label = pane === 'main' ? 'Main pane' : 'Second pane'
          const activate = () => {
            if (visible && state.activePane !== pane) store.activatePane(pane)
          }
          return (
            <aside
              key={pane}
              ref={pane === 'main' ? mainPane : secondPane}
              className="detail-pane"
              aria-label={split ? label : 'Session detail'}
              data-pane={pane}
              data-active={state.activePane === pane}
              tabIndex={-1}
              hidden={!visible}
              onPointerDownCapture={activate}
              onFocusCapture={activate}
            >
              {pane === 'main' && state.narrow && state.detailOpen && (
                <button className="detail-back" type="button" onClick={store.back}>
                  ‹ {VIEW_NAMES[view]}
                </button>
              )}
              {split && (
                <div className="pane-toolbar">
                  <span>{label}</span>
                  <span className="pane-active">{state.activePane === pane ? 'Active' : ''}</span>
                  {pane === 'second' && (
                    <button type="button" onClick={store.closeSecondary}>
                      Close Second Pane
                    </button>
                  )}
                </div>
              )}
              {selected ? (
                <SessionDetail
                  key={`${pane}:${sessionKeyToString(selected.key)}`}
                  session={selected}
                  api={window.agentpeek}
                  visible={visible}
                  focused={windowFocused}
                  paneLabel={split ? label : undefined}
                  onOpenSecondary={
                    pane === 'main' ? () => store.openSecondary(selected.key) : undefined
                  }
                  canAutoRead={() => store.canAutoRead(pane, selected.key, state.targetGeneration)}
                  missing={!snapshot?.sessions.some((s) => sameKey(s.key, selected.key))}
                  lastSeenAt={selection.lastSeenAt}
                  sourceEpoch={selection.sourceEpoch}
                  reloadPending={state.reloadPending}
                  reloadVersion={state.reloadVersion}
                  onReload={store.reload}
                />
              ) : (
                <div className="detail-placeholder">
                  <h2>No session selected</h2>
                  <p>Select a session to see its latest exchange.</p>
                </div>
              )}
            </aside>
          )
        })}
      </div>
    </div>
  )
}
