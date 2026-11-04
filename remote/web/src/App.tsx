import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { macNow, type StatusFrame } from '../../../src/core/remote/protocol'
import { createConnection, type Connection, type ViewerData, type ViewerState } from './connection'
import { createDetails, type Details, type DetailState } from './details'
import { SessionDetail } from './SessionDetail'
import { SessionList } from './SessionList'
import { Sidebar } from './Sidebar'
import { DEFAULT_CHOICES, VIEW_NAMES, viewSummary, type ListChoices } from './status-view'

// The Remote View page that a browser on the owner's tailnet opens. TASK-017 owns the connection
// entry: connecting, live, reconnecting, connection lost, too many pages, off, and the final
// not-allowed, wrong-address and update-needed states, with the TASK-002 copy. TASK-018 owns the
// read-only session list under it and the header summary. TASK-033 adds one session's recent
// messages while the Mac shares them. The layout follows the desktop window: from 960 px a
// sidebar (views and sources), the list and the detail side by side; below 960 px the list alone,
// the sidebar behind the header's menu button, and an open detail in the list's place.
//
// Back: opening a detail adds one history entry whose state is a fixed marker (never a session ID
// or text), so the phone's Back gesture returns to the list; Back from the list leaves the page.

/** The only history state the page writes. */
const DETAIL_MARKER = { agentpeek: 'detail' } as const

export interface AppProps {
  /** Tests pass their own; the page uses the browser's. */
  fetch?: typeof fetch
  random?: () => number
  /** A monotonic local clock; `performance.now` by default. */
  now?: () => number
  /** How often live ages move on between frames. */
  tickMs?: number
}

/** Live ages move on at least this often; heartbeats also refresh them every 15 s. */
const TICK_MS = 10_000

export function App({ fetch: fetchImpl, random, now = defaultNow, tickMs = TICK_MS }: AppProps) {
  const [state, setState] = useState<ViewerState>({ kind: 'connecting' })
  const [choices, setChoices] = useState<ListChoices>(DEFAULT_CHOICES)
  const [menuOpen, setMenuOpen] = useState(false)
  const sidebarId = useId()
  const menuButton = useRef<HTMLButtonElement>(null)
  const connection = useRef<Connection | null>(null)
  const [detail, setDetail] = useState<DetailState | null>(null)
  const details = useRef<Details | null>(null)
  /** Whether the open detail added a history entry that Back should consume. */
  const pushed = useRef(false)

  useEffect(() => {
    const createdDetails = createDetails({
      fetch: fetchImpl ?? window.fetch.bind(window),
      now,
      onChange: setDetail
    })
    details.current = createdDetails
    const created = createConnection({
      fetch: fetchImpl ?? window.fetch.bind(window),
      random,
      now,
      onChange: (next) => {
        setState(next)
        followConnection(createdDetails, next)
        // When access ends and the data goes, the page's choices start over too.
        if (!('data' in next) || next.data === null) setChoices(DEFAULT_CHOICES)
      }
    })
    connection.current = created
    const visibility = () => {
      if (document.hidden) created.suspend()
      else created.resume()
    }
    const hide = () => created.suspend()
    document.addEventListener('visibilitychange', visibility)
    document.addEventListener('freeze', hide)
    document.addEventListener('resume', visibility)
    window.addEventListener('pagehide', hide)
    window.addEventListener('pageshow', visibility)
    // The phone's Back gesture, or the in-page Back after it called history.back().
    const popped = () => {
      pushed.current = false
      createdDetails.close()
    }
    window.addEventListener('popstate', popped)
    if (document.hidden) created.suspend()
    else created.start()
    return () => {
      window.removeEventListener('popstate', popped)
      createdDetails.close()
      document.removeEventListener('visibilitychange', visibility)
      document.removeEventListener('freeze', hide)
      document.removeEventListener('resume', visibility)
      window.removeEventListener('pagehide', hide)
      window.removeEventListener('pageshow', visibility)
      created.stop()
    }
  }, [fetchImpl, random, now])

  const live = state.kind === 'live'
  const [localNow, setLocalNow] = useState(now)
  useEffect(() => {
    if (!live) return
    const timer = setInterval(() => setLocalNow(now()), tickMs)
    return () => clearInterval(timer)
  }, [live, now, tickMs])

  const data = 'data' in state ? state.data : null

  // The detail closed itself (access ended): the entry it added goes too. Focus goes back to
  // the row that opened it, when it is still there.
  const openSession = detail?.session ?? null
  const lastOpen = useRef<string | null>(null)
  useEffect(() => {
    if (openSession !== null) {
      lastOpen.current = openSession
      return
    }
    if (pushed.current) {
      pushed.current = false
      window.history.back()
    }
    const previous = lastOpen.current
    lastOpen.current = null
    if (previous !== null) {
      document.querySelector<HTMLElement>(`button[data-session="${previous}"]`)?.focus()
    }
  }, [openSession])

  const open = (session: string) => {
    if (!pushed.current) {
      window.history.pushState(DETAIL_MARKER, '')
      pushed.current = true
    }
    details.current?.open(session)
  }
  const back = () => {
    // popstate then closes the detail, so Back and the gesture behave the same.
    if (pushed.current) window.history.back()
    else details.current?.close()
  }
  const retryDetail = () => details.current?.retry()
  const shown =
    detail && data ? { ...findSession(data.frame, detail.session), view: detail.view } : null

  const retry = () => connection.current?.retryNow()
  // Ages use the Mac's clock: while live, the last frame's time plus the local time since it came
  // (protocol v1, time authority); kept data stays at its "showing data from" time.
  const checkedAt =
    data === null ? 0 : live ? macNow(data.lastSentAt, data.receivedAt, localNow) : data.lastSentAt
  const list = {
    choices,
    onChoices: setChoices,
    checkedAt,
    // Rows open recent messages only while the Mac shares them and the stream is live.
    onOpen: live && data?.frame.details ? open : undefined,
    selected: detail?.session ?? null
  }
  const closeMenu = () => {
    setMenuOpen(false)
    menuButton.current?.focus()
  }
  // The open menu takes focus and closes on Escape from anywhere on the page.
  useEffect(() => {
    if (!menuOpen) return
    document
      .getElementById(sidebarId)
      ?.querySelector<HTMLElement>('[aria-current="page"], button')
      ?.focus()
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false)
        menuButton.current?.focus()
      }
    }
    document.addEventListener('keydown', escape)
    return () => document.removeEventListener('keydown', escape)
  }, [menuOpen, sidebarId])

  return (
    <div className="layout" data-js="">
      <Sidebar
        id={sidebarId}
        data={data}
        choices={choices}
        onView={(view) => setChoices((current) => ({ ...current, view }))}
        open={menuOpen}
        onClose={closeMenu}
      />
      <div className="content">
        <header>
          <button
            ref={menuButton}
            type="button"
            className="menu-button"
            aria-label="Show views"
            aria-expanded={menuOpen}
            aria-controls={sidebarId}
            onClick={() => setMenuOpen(true)}
          >
            <span className="menu-bars" aria-hidden="true" />
          </button>
          <h1 className="visually-hidden">AgentPeek</h1>
          <p className="view-title">{VIEW_NAMES[choices.view]}</p>
          <Pill state={state} />
          {data && <Summary data={data} dimmed={state.kind !== 'live'} />}
        </header>
        <main className={shown ? 'split' : undefined}>
          <div className={shown ? 'list-pane split-list' : 'list-pane'}>
            <Body state={state} onRetry={retry} list={list} />
          </div>
          {shown ? (
            <SessionDetail {...shown} onBack={back} onRetry={retryDetail} />
          ) : (
            <EmptyDetail data={data} live={live} />
          )}
        </main>
      </div>
    </div>
  )
}

/** "1 need attention · 6 running · 0 unknown" over every shared session, like the desktop. */
function Summary({ data, dimmed }: { data: ViewerData; dimmed: boolean }) {
  if (data.frame.status.projects.length === 0) return null
  return <p className={dimmed ? 'summary dimmed' : 'summary'}>{viewSummary(data.frame.status)}</p>
}

/** The detail column with nothing open; shown from 960 px only. */
function EmptyDetail({ data, live }: { data: ViewerData | null; live: boolean }) {
  if (!data || data.frame.status.projects.length === 0) return <div className="detail-empty" />
  return (
    <div className="detail-empty">
      {live && data.frame.details ? (
        <>
          <p className="detail-empty-title">No session selected</p>
          <p className="hint">Select a session to see its latest messages.</p>
        </>
      ) : (
        <p className="hint">
          To read sessions here, turn on Share recent messages in AgentPeek on the Mac.
        </p>
      )}
    </div>
  )
}

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const time = (ms: number) => timeFormat.format(new Date(ms))

/** The state word is the live region, so a screen reader hears changes, not every heartbeat. */
function Pill({ state }: { state: ViewerState }) {
  const pill = pillOf(state)
  if (!pill) return null
  return (
    <p className={`pill pill-${pill.tone}`}>
      <span role="status" className="pill-label">
        {pill.label}
      </span>
      {pill.detail && <span className="pill-detail">{pill.detail}</span>}
    </p>
  )
}

function pillOf(
  state: ViewerState
): { label: string; detail?: string; tone: 'neutral' | 'live' | 'warn' | 'error' } | null {
  const from = (data: ViewerData | null) =>
    data ? `showing data from ${time(data.lastSentAt)}` : undefined
  switch (state.kind) {
    case 'connecting':
      return { label: 'Connecting…', tone: 'neutral' }
    case 'live':
      return {
        label: 'Live',
        detail: `last change ${time(state.data.frame.observedAt)} · checked ${time(state.data.lastSentAt)}`,
        tone: 'live'
      }
    case 'reconnecting':
      return { label: 'Reconnecting', detail: from(state.data), tone: 'warn' }
    case 'lost':
      return { label: 'Connection lost', detail: from(state.data), tone: 'error' }
    case 'busy':
      return { label: 'Too many open pages', tone: 'warn' }
    case 'off':
      return { label: 'Remote View is off', tone: 'neutral' }
    case 'update-needed':
      return { label: 'Update needed', tone: 'error' }
    default:
      return null
  }
}

type ListState = {
  choices: ListChoices
  onChoices: (choices: ListChoices) => void
  checkedAt: number
}

function Body({
  state,
  onRetry,
  list
}: {
  state: ViewerState
  onRetry: () => void
  list: ListState
}) {
  switch (state.kind) {
    case 'connecting':
      return <Skeleton />
    case 'live':
      return <SessionList data={state.data} {...list} />
    case 'reconnecting':
      return state.data ? <SessionList data={state.data} {...list} dimmed /> : <Skeleton />
    case 'lost':
      return (
        <>
          <Notice>
            <p>AgentPeek may be closed, or the Mac asleep or offline.</p>
            <p className="hint">
              This page keeps trying. If you reload it while AgentPeek is closed, Tailscale shows
              its own error page instead of this one.
            </p>
            <button type="button" onClick={onRetry}>
              Retry
            </button>
          </Notice>
          {state.data && <SessionList data={state.data} {...list} dimmed />}
        </>
      )
    case 'busy':
      return (
        <>
          <Notice>
            <p>Close another AgentPeek viewer tab, then Retry.</p>
            <button type="button" onClick={onRetry}>
              Retry
            </button>
          </Notice>
          {state.data && <SessionList data={state.data} {...list} dimmed />}
        </>
      )
    case 'off':
      return (
        <Notice>
          <p>Remote View was turned off on the Mac.</p>
          <p className="hint">This page reconnects when it is turned on again.</p>
        </Notice>
      )
    case 'not-allowed':
      return (
        <Notice>
          <p>
            Not allowed. This page only opens for the Tailscale login set in AgentPeek on the Mac.
          </p>
        </Notice>
      )
    case 'bad-host':
      return (
        <Notice>
          <p>Open this page with the Mac address set in AgentPeek.</p>
        </Notice>
      )
    case 'update-needed':
      return (
        <Notice>
          <p>AgentPeek on the Mac was updated. Reload this page.</p>
          <ReloadButton />
        </Notice>
      )
    case 'failed':
      return (
        <Notice>
          <p>Something went wrong. Reload this page.</p>
          <ReloadButton />
        </Notice>
      )
  }
}

function Notice({ children }: { children: ReactNode }) {
  return <section className="notice">{children}</section>
}

/** A reload replaces the page in place; the page never adds history entries. */
function ReloadButton() {
  return (
    <button type="button" onClick={() => window.location.reload()}>
      Reload
    </button>
  )
}

function Skeleton() {
  return (
    <div className="skeleton" aria-hidden="true">
      <div />
      <div />
      <div />
    </div>
  )
}

/** The detail follows the stream: live statuses rebind it, a drop pauses it, access end closes it. */
function followConnection(details: Details, state: ViewerState): void {
  switch (state.kind) {
    case 'live':
      return details.status(state.data.frame)
    case 'reconnecting':
    case 'lost':
    case 'busy':
      return details.pause()
    default:
      // connecting (after access-changed), off and every final state.
      return details.close()
  }
}

function findSession(frame: StatusFrame, id: string) {
  for (const project of frame.status.projects) {
    const session = project.sessions.find((row) => row.id === id)
    if (session) return { session, project: project.label }
  }
  return { session: null, project: null }
}

function defaultNow(): number {
  return performance.now()
}
