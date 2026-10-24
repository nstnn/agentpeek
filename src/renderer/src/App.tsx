import {
  Fragment,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type DragEvent,
  type SyntheticEvent,
  type JSX
} from 'react'
import { sessionKeyToString, type Session } from '../../core/session'
import { buildView } from '../../core/views'
import { createSessionsStore, displayedGroups, sameKey, type SessionsStore } from './sessions-store'
import { VIEW_NAMES } from './session-display'
import { Sidebar, SessionBanners, EmptyList } from './session-panels'
import { SessionList } from './SessionList'
import { SessionDetail } from './SessionDetail'
import { PaneDivider } from './PaneDivider'
import { clamp, layoutCapacity, paneLayout, type PaneSizes } from './pane-layout'
import { NavigationIcon } from './NavigationIcon'
import { useNavigationMotion } from './use-navigation-motion'
import { SettingsDialog } from './SettingsDialog'

export function App({ store: suppliedStore }: { store?: SessionsStore }): JSX.Element {
  const [store] = useState(() => suppliedStore ?? createSessionsStore(window.agentpeek))
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const { snapshot, view, filter } = state
  const [now, setNow] = useState(Date.now)
  const [firstLaunchDismissed, dismissFirstLaunch] = useState(false)
  const [windowFocused, setWindowFocused] = useState(() => document.hasFocus())
  const [dragSession, setDragSession] = useState<Session | null>(null)
  const [dropPane, setDropPane] = useState<'main' | 'second' | null>(null)
  const [dropLeft, setDropLeft] = useState(0)
  const [zoomNotice, setZoomNotice] = useState<{ percent: number; failed?: boolean } | null>(null)
  const workspace = useRef<HTMLDivElement>(null)
  const regionId = useId()
  const [workspaceWidth, setWorkspaceWidth] = useState(() => window.innerWidth)
  const [paneSizes, setPaneSizes] = useState<PaneSizes>({})
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [paneInstances, setPaneInstances] = useState({ main: 'main', second: 'second' })
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = window.agentpeek.onCommand((command) => {
      if (typeof command !== 'object' || command.type !== 'zoom') return
      clearTimeout(timer)
      setZoomNotice(command)
      timer = setTimeout(() => setZoomNotice(null), command.failed ? 6000 : 1800)
    })
    return () => {
      unsubscribe()
      clearTimeout(timer)
    }
  }, [])
  const mainPane = useRef<HTMLElement>(null)
  const secondPane = useRef<HTMLElement>(null)
  const navigation = useRef<HTMLElement>(null)
  const focusRevealedList = useRef(false)
  const previousSecond = useRef<string | null>(null)
  const previousPlacement = useRef(0)
  const previousLayout = useRef({
    reading: false,
    split: false,
    narrow: false,
    roomy: false,
    collapsed: false,
    navigationVisible: true
  })
  const paneAtDrop = (event: DragEvent): 'main' | 'second' | null => {
    const targets = workspace.current?.querySelectorAll<HTMLElement>('[data-drop-pane]') ?? []
    for (const target of targets) {
      const bounds = target.getBoundingClientRect()
      if (
        bounds.width > 0 &&
        bounds.height > 0 &&
        event.clientX >= bounds.left &&
        event.clientX <= bounds.right &&
        event.clientY >= bounds.top &&
        event.clientY <= bounds.bottom
      )
        return target.dataset.dropPane as 'main' | 'second'
    }
    return null
  }
  const split = !!state.secondarySelection
  const reading = split ? !state.splitBrowsing : !state.narrow || state.detailOpen
  const navigationVisible = split
    ? state.splitBrowsing || (state.roomy && !state.sessionsHidden)
    : (!state.narrow || !state.detailOpen) && (!state.sessionsHidden || !state.selection)
  const mainVisible = reading && (!split || !state.narrow || state.activePane === 'main')
  const secondVisible = split && reading && (!state.narrow || state.activePane === 'second')
  const detailCount = Number(mainVisible) + Number(secondVisible)
  const layout = paneLayout(workspaceWidth, paneSizes, {
    sidebar: true,
    list: navigationVisible,
    details: detailCount,
    split,
    narrow: state.narrow,
    collapsed: sidebarCollapsed
  })
  // Each divider trades space between its immediate neighbours.
  const sidebarMax =
    navigationVisible && detailCount
      ? Math.min(layout.sidebarMax, layout.sidebar + layout.list - layout.listMin)
      : layout.sidebarMax
  const listMax = detailCount === 2 ? layout.list + layout.main - layout.detailMin : layout.listMax
  const resizeSidebar = (value: number) => {
    const sidebar = clamp(value, layout.sidebarMin, sidebarMax)
    setPaneSizes((sizes) => ({
      ...sizes,
      sidebar,
      ...(navigationVisible && detailCount
        ? { [split ? 'splitList' : 'singleList']: layout.list + layout.sidebar - sidebar }
        : {})
    }))
  }
  const resizeList = (value: number) => {
    const list = clamp(value, layout.listMin, listMax)
    setPaneSizes((sizes) => ({
      ...sizes,
      [split ? 'splitList' : 'singleList']: list,
      ...(detailCount === 2
        ? {
            splitRatio:
              (layout.main + layout.list - list) /
              (layout.main + layout.second + layout.list - list)
          }
        : {})
    }))
  }
  useLayoutEffect(() => {
    const element = workspace.current
    if (!element) return
    const update = (width: number) => {
      if (width > 0) setWorkspaceWidth(width)
    }
    update(element.getBoundingClientRect().width)
    const observer = new ResizeObserver(([entry]) => {
      if (entry) update(entry.contentRect.width)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  useLayoutEffect(() => {
    const capacity = layoutCapacity(workspaceWidth, paneSizes, sidebarCollapsed, split)
    store.setLayout(capacity.narrow, capacity.roomy)
  }, [store, workspaceWidth, paneSizes, sidebarCollapsed, split])
  useLayoutEffect(() => {
    store.setVisiblePanes([
      ...(mainVisible ? (['main'] as const) : []),
      ...(secondVisible ? (['second'] as const) : [])
    ])
  }, [store, mainVisible, secondVisible])
  const secondKey = state.secondarySelection
    ? sessionKeyToString(state.secondarySelection.session.key)
    : null
  useLayoutEffect(() => {
    const placed = previousPlacement.current !== state.placementVersion
    if (state.settingsOpen) return
    const previous = previousLayout.current
    const active = document.activeElement as HTMLElement | null
    const hiddenFocus = !!active?.closest('[hidden]')
    const closed = previousSecond.current && !secondKey
    const target = state.activePane === 'second' ? secondPane.current : mainPane.current
    const focusList = () =>
      (
        navigation.current?.querySelector<HTMLElement>('.list-scroll') ??
        navigation.current?.querySelector<HTMLElement>('.tool-filter [aria-checked=true]') ??
        navigation.current?.querySelector<HTMLElement>('button:not(:disabled):not([tabindex="-1"])')
      )?.focus({ preventScroll: true })
    if (focusRevealedList.current && navigationVisible) {
      focusRevealedList.current = false
      focusList()
    } else if ((!reading && previous.reading) || (closed && (!reading || !state.selection))) {
      focusList()
    } else if (reading && (!previous.reading || closed || placed)) {
      if (!split && state.narrow)
        mainPane.current?.querySelector<HTMLButtonElement>('.detail-back')?.focus()
      else target?.focus({ preventScroll: true })
    } else if (
      hiddenFocus ||
      (active === document.body &&
        (previous.narrow !== state.narrow ||
          previous.roomy !== state.roomy ||
          previous.collapsed !== sidebarCollapsed ||
          previous.navigationVisible !== navigationVisible))
    ) {
      // A layout change can hide a focused list, selector or pane control. Keep
      // focus on the same reading target instead of activating its sibling.
      if (reading) target?.focus({ preventScroll: true })
      else focusList()
    }
    previousSecond.current = secondKey
    previousPlacement.current = state.placementVersion
    previousLayout.current = {
      reading,
      split,
      narrow: state.narrow,
      roomy: state.roomy,
      collapsed: sidebarCollapsed,
      navigationVisible
    }
  }, [
    secondKey,
    secondVisible,
    state.activePane,
    state.placementVersion,
    state.selection,
    reading,
    split,
    state.narrow,
    state.roomy,
    navigationVisible,
    sidebarCollapsed,
    state.settingsOpen
  ])
  const stopNavigationMotion = useNavigationMotion(
    workspace,
    sidebarCollapsed,
    navigationVisible,
    workspaceWidth,
    paneSizes
  )
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
    const shortcut = (event: KeyboardEvent) => {
      if (
        state.settingsOpen ||
        event.defaultPrevented ||
        !event.metaKey ||
        !event.shiftKey ||
        event.altKey ||
        event.ctrlKey
      )
        return
      if (event.key.toLowerCase() === 'b') {
        event.preventDefault()
        setSidebarCollapsed((collapsed) => !collapsed)
      } else if (event.key.toLowerCase() === 'l') {
        event.preventDefault()
        if (navigationVisible) store.hideSessions()
        else store.showSessions()
      }
    }
    window.addEventListener('keydown', shortcut)
    return () => window.removeEventListener('keydown', shortcut)
  }, [store, navigationVisible, state.settingsOpen])
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])
  // A removed source can detach the drag origin before Chromium sends dragend.
  if (dragSession && !snapshot?.sessions.some((s) => sameKey(s.key, dragSession.key))) {
    setDragSession(null)
    setDropPane(null)
  }
  const contents = buildView(snapshot?.sessions ?? [], view, filter)
  const groups = displayedGroups(state)
  const sessions = contents.groups.flatMap((group) => group.sessions)
  const attention = sessions.filter(
    (s) => s.attention.waiting || s.attention.error || s.attention.newReply
  ).length
  const running = sessions.filter((s) => s.activity.state === 'running').length
  const unknown = sessions.filter((s) => s.activity.state === 'unknown').length
  const paneTitles = {
    main: state.selection
      ? state.selection.session.summary.title || 'Untitled session'
      : 'No session selected',
    second: state.secondarySelection?.session.summary.title || 'Untitled session'
  }
  const sessionsToggle = (
    <button
      type="button"
      className={`navigation-toggle${!split && state.narrow && !navigationVisible ? ' detail-back' : ''}`}
      data-navigation-control="sessions"
      aria-label={navigationVisible ? 'Hide Sessions' : 'Show Sessions'}
      title={`${navigationVisible ? 'Hide' : 'Show'} sessions (⇧⌘L)`}
      aria-expanded={navigationVisible}
      aria-controls={`${regionId}-sessions`}
      aria-keyshortcuts="Meta+Shift+L"
      disabled={navigationVisible && !state.selection && !state.secondarySelection}
      onClick={() => {
        if (navigationVisible) store.hideSessions()
        else {
          focusRevealedList.current = true
          store.showSessions()
        }
      }}
    >
      <NavigationIcon kind="sessions" />
    </button>
  )
  const zoomFeedback = zoomNotice && (
    <div className="zoom-notice" role="status">
      {zoomNotice.failed
        ? `Couldn't save zoom. Restored to ${zoomNotice.percent}%. Try again.`
        : `Zoom ${zoomNotice.percent}%`}
    </div>
  )
  return (
    <div
      className="app-shell"
      data-window-focused={windowFocused}
      onKeyDown={(event) => {
        if (state.settingsOpen) return
        if (event.key === 'Escape' && dragSession) {
          event.preventDefault()
          setDragSession(null)
          setDropPane(null)
          return
        }
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
      {split && state.narrow && reading && (
        <div className="split-navigation">
          <div role="radiogroup" aria-label="Visible session pane" className="pane-selector">
            {(['main', 'second'] as const).map((pane) => (
              <button
                type="button"
                key={pane}
                role="radio"
                aria-label={`${paneTitles[pane]} (${pane === 'main' ? 'Left' : 'Right'} pane)`}
                title={paneTitles[pane]}
                aria-checked={state.activePane === pane}
                disabled={pane === 'main' && !state.selection}
                tabIndex={state.activePane === pane ? 0 : -1}
                onClick={() => store.activatePane(pane)}
                onKeyDown={(event) => {
                  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
                  event.preventDefault()
                  const next =
                    event.key === 'Home'
                      ? 'main'
                      : event.key === 'End'
                        ? 'second'
                        : pane === 'main'
                          ? 'second'
                          : 'main'
                  if (next === 'main' && !state.selection) return
                  store.activatePane(next)
                  event.currentTarget.parentElement
                    ?.querySelectorAll<HTMLButtonElement>('button')
                    [next === 'main' ? 0 : 1]?.focus()
                }}
              >
                {paneTitles[pane]}
              </button>
            ))}
          </div>
        </div>
      )}
      <div
        ref={workspace}
        onPointerDownCapture={(event) => {
          if ((event.target as HTMLElement).closest('.pane-divider')) stopNavigationMotion()
        }}
        onKeyDownCapture={(event) => {
          if ((event.target as HTMLElement).closest('.pane-divider')) stopNavigationMotion()
        }}
        onDragOver={(event) => {
          if (!dragSession || !event.dataTransfer.types.includes('application/x-agentpeek-session'))
            return
          const pane = paneAtDrop(event)
          if (pane) {
            event.preventDefault()
            event.dataTransfer.dropEffect = 'copy'
          }
          setDropPane(pane)
        }}
        onDragLeave={(event) => {
          if (
            !(event.relatedTarget instanceof Node) ||
            !event.currentTarget.contains(event.relatedTarget)
          )
            setDropPane(null)
        }}
        onDrop={(event) => {
          if (!dragSession) return
          event.preventDefault()
          const pane = paneAtDrop(event)
          if (
            pane &&
            event.dataTransfer.getData('application/x-agentpeek-session') ===
              sessionKeyToString(dragSession.key)
          ) {
            store.openPane(pane, dragSession.key)
          }
          setDragSession(null)
          setDropPane(null)
        }}
        className={`workspace${split ? ' split-workspace' : ''}${split && state.splitBrowsing ? ' browsing-workspace' : ''}`}
      >
        <div
          id={`${regionId}-sidebar`}
          className="sidebar-container"
          data-motion-region="sidebar"
          style={{ flex: `0 0 ${layout.sidebar}px` }}
        >
          <Sidebar
            snapshot={snapshot}
            view={view}
            onView={store.setView}
            collapsed={sidebarCollapsed}
            onToggle={() => setSidebarCollapsed((collapsed) => !collapsed)}
            controls={`${regionId}-sidebar`}
            onSettings={store.openSettings}
          />
        </div>
        <PaneDivider
          motionRegion="sidebar-divider"
          hidden={sidebarCollapsed || (!navigationVisible && detailCount === 0)}
          label="Sidebar width"
          controls={`${regionId}-sidebar`}
          value={layout.sidebar}
          min={layout.sidebarMin}
          max={sidebarMax}
          onChange={resizeSidebar}
          onReset={() => resizeSidebar(190)}
        />
        <main
          id={`${regionId}-sessions`}
          className="sessions-pane"
          data-motion-region="sessions"
          style={{ flex: `0 0 ${layout.list}px` }}
          ref={navigation}
          aria-label="Sessions"
          hidden={!navigationVisible}
          inert={!navigationVisible}
          aria-hidden={!navigationVisible || undefined}
        >
          <div className="navigation-motion-content">
            <header className="list-header">
              <div className="list-heading">
                {navigationVisible && sessionsToggle}
                <h1>{VIEW_NAMES[view]}</h1>
                {state.splitBrowsing && (
                  <button
                    type="button"
                    className="pane-close"
                    aria-label="Close Right Pane"
                    title="Close Right Pane"
                    onClick={store.closeSecondary}
                  >
                    <span aria-hidden="true">×</span>
                  </button>
                )}
              </div>
              <p className="summary">
                {attention} need attention · {running} running · {unknown} unknown
              </p>
              <div className="grouping-control">
                <span>Group by</span>
                <div className="grouping-options" role="radiogroup" aria-label="Group sessions by">
                  {(['project', 'status'] as const).map((grouping) => (
                    <button
                      key={grouping}
                      type="button"
                      role="radio"
                      aria-checked={state.grouping === grouping}
                      tabIndex={state.grouping === grouping ? 0 : -1}
                      onClick={() => store.setGrouping(grouping)}
                      onKeyDown={(event) => {
                        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
                        event.preventDefault()
                        const next =
                          event.key === 'Home'
                            ? 'project'
                            : event.key === 'End'
                              ? 'status'
                              : grouping === 'project'
                                ? 'status'
                                : 'project'
                        store.setGrouping(next)
                        event.currentTarget.parentElement
                          ?.querySelectorAll('button')
                          [next === 'project' ? 0 : 1]?.focus()
                      }}
                    >
                      {grouping === 'project' ? 'Project' : 'Status'}
                    </button>
                  ))}
                </div>
              </div>
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
                  First launch: replies that finished before now count as read. New replies will
                  show up here from now on.
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
                hidden={!navigationVisible}
                onSessionDrag={(session) => {
                  const bounds = workspace.current?.getBoundingClientRect()
                  const pane = mainPane.current?.getBoundingClientRect()
                  // Browsing keeps the source list reachable; reading previews actual pane bounds.
                  setDropLeft(
                    bounds && pane && mainVisible
                      ? pane.left - bounds.left + (split ? 0 : pane.width / 2)
                      : (bounds?.width ?? 0) * 0.35
                  )
                  setDragSession(session)
                  setDropPane(null)
                }}
                onSessionDragEnd={() => {
                  setDragSession(null)
                  setDropPane(null)
                }}
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
                onSettings={store.openSettings}
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
          </div>
        </main>
        <PaneDivider
          motionRegion="sessions-divider"
          hidden={!navigationVisible || detailCount === 0}
          label="Sessions width"
          controls={`${regionId}-sessions`}
          value={layout.list}
          min={layout.listMin}
          max={listMax}
          onChange={resizeList}
          onReset={() => resizeList(split ? 300 : 360)}
        />
        {(['main', 'second'] as const).map((pane) => {
          const selection = pane === 'main' ? state.selection : state.secondarySelection
          if (pane === 'second' && !selection) return null
          const selected = selection?.session
          const visible = pane === 'main' ? mainVisible : secondVisible
          const label = pane === 'main' ? 'Left pane' : 'Right pane'
          const activate = (event: SyntheticEvent<HTMLElement>) => {
            if ((event.target as HTMLElement).closest('[data-navigation-control]')) return
            if (visible && state.activePane !== pane) store.activatePane(pane)
          }
          return (
            <Fragment key={paneInstances[pane]}>
              {pane === 'second' && (
                <PaneDivider
                  motionRegion="detail-divider"
                  hidden={!mainVisible || !secondVisible}
                  label={`${paneTitles.main} (Left pane) width`}
                  controls={`${regionId}-main`}
                  value={layout.main}
                  min={layout.detailMin}
                  max={layout.mainMax}
                  onChange={(value) =>
                    setPaneSizes((sizes) => ({
                      ...sizes,
                      splitRatio: value / (layout.main + layout.second)
                    }))
                  }
                  onReset={() => setPaneSizes((sizes) => ({ ...sizes, splitRatio: 0.5 }))}
                />
              )}
              <aside
                id={`${regionId}-${pane}`}
                ref={pane === 'main' ? mainPane : secondPane}
                className="detail-pane"
                data-motion-region={pane}
                style={{
                  flex: `0 0 ${pane === 'main' || detailCount === 1 ? layout.main : layout.second}px`
                }}
                aria-label={split ? label : 'Session detail'}
                data-pane={pane}
                data-active={state.activePane === pane}
                tabIndex={-1}
                hidden={!visible}
                inert={!visible}
                aria-hidden={!visible || undefined}
                onPointerDownCapture={activate}
                onFocusCapture={activate}
              >
                <div className="navigation-motion-content">
                  {split && (
                    <div className="pane-toolbar">
                      {!navigationVisible &&
                        visible &&
                        (pane === 'main' || !mainVisible) &&
                        sessionsToggle}
                      <h2 className="pane-title" title={paneTitles[pane]}>
                        {paneTitles[pane]}
                      </h2>
                      <span className="pane-active">
                        {state.activePane === pane ? 'Active' : ''}
                      </span>
                      <button
                        type="button"
                        className="pane-close"
                        aria-label={`Close ${pane === 'main' ? 'Left' : 'Right'} Pane`}
                        title={`Close ${pane === 'main' ? 'Left' : 'Right'} Pane`}
                        onClick={() => {
                          if (pane === 'main') {
                            // Move the surviving detail without remounting its transcript.
                            setPaneInstances(({ main, second }) => ({ main: second, second: main }))
                          }
                          store.closePane(pane)
                        }}
                      >
                        <span aria-hidden="true">×</span>
                      </button>
                    </div>
                  )}
                  {selected ? (
                    <SessionDetail
                      key={`${paneInstances[pane]}:${sessionKeyToString(selected.key)}`}
                      session={selected}
                      api={window.agentpeek}
                      visible={visible && !state.settingsOpen}
                      focused={windowFocused && !state.settingsOpen}
                      paneLabel={split ? label : undefined}
                      showTitle={!split}
                      leadingControl={!split && !navigationVisible ? sessionsToggle : undefined}
                      canAutoRead={() =>
                        store.canAutoRead(pane, selected.key, state.targetGeneration)
                      }
                      monitoringOff={snapshot?.health[selected.key.tool].state === 'off'}
                      onSettings={store.openSettings}
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
                </div>
              </aside>
            </Fragment>
          )
        })}
        {dragSession && (
          <div className="session-drop-targets" style={{ left: dropLeft }}>
            {(split ? (['main', 'second'] as const) : (['second'] as const)).map((pane) => (
              <div
                key={pane}
                role="region"
                aria-label={`Drop in ${pane === 'main' ? 'Left' : 'Right'} Pane`}
                className={`session-drop-target${dropPane === pane ? ' drag-over' : ''}`}
                data-drop-pane={pane}
              >
                <strong>
                  {split
                    ? `Replace ${pane === 'main' ? 'left' : 'right'} pane`
                    : 'Open to the right'}
                </strong>
                <span>{dragSession.summary.title || 'Untitled session'}</span>
                <small>Drop to open · Esc to cancel</small>
              </div>
            ))}
          </div>
        )}
      </div>
      {state.settingsOpen && (
        <SettingsDialog
          api={window.agentpeek}
          snapshot={snapshot}
          onClose={store.closeSettings}
          feedback={zoomFeedback}
        />
      )}
      {!state.settingsOpen && zoomFeedback}
    </div>
  )
}
