import { useEffect, useRef, useState, type ReactNode } from 'react'
import { macNow } from '../../../src/core/remote/protocol'
import { createConnection, type Connection, type ViewerData, type ViewerState } from './connection'
import { SessionList } from './SessionList'
import { NO_FILTERS, statusView, summaryText, type Filters } from './status-view'

// The Remote View page that a browser on the owner's tailnet opens. TASK-017 owns the connection
// entry: connecting, live, reconnecting, connection lost, too many pages, off, and the final
// not-allowed, wrong-address and update-needed states, with the TASK-002 copy. TASK-018 owns the
// read-only session list under it and the header summary.

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
  const [filters, setFilters] = useState<Filters>(NO_FILTERS)
  const connection = useRef<Connection | null>(null)

  useEffect(() => {
    const created = createConnection({
      fetch: fetchImpl ?? window.fetch.bind(window),
      random,
      now,
      onChange: (next) => {
        setState(next)
        // Project labels are session data too: when access ends and the data goes, so do the filters.
        if (!('data' in next) || next.data === null) setFilters(NO_FILTERS)
        // A filter on a project the Mac no longer shares goes too, so it cannot come back unasked.
        else if (next.kind === 'live') {
          const labels = next.data.frame.status.projects.map((project) => project.label)
          setFilters((current) =>
            current.project !== null && !labels.includes(current.project)
              ? { ...current, project: null }
              : current
          )
        }
      }
    })
    connection.current = created
    created.start()
    return () => created.stop()
  }, [fetchImpl, random, now])

  const live = state.kind === 'live'
  const [localNow, setLocalNow] = useState(now)
  useEffect(() => {
    if (!live) return
    const timer = setInterval(() => setLocalNow(now()), tickMs)
    return () => clearInterval(timer)
  }, [live, now, tickMs])

  const data = 'data' in state ? state.data : null

  const retry = () => connection.current?.retryNow()
  // Ages use the Mac's clock: while live, the last frame's time plus the local time since it came
  // (protocol v1, time authority); kept data stays at its "showing data from" time.
  const checkedAt =
    data === null ? 0 : live ? macNow(data.lastSentAt, data.receivedAt, localNow) : data.lastSentAt
  const list = { filters, onFilters: setFilters, checkedAt }
  return (
    <>
      <header>
        <h1>AgentPeek</h1>
        <Pill state={state} />
        {data && <Summary data={data} dimmed={state.kind !== 'live'} />}
      </header>
      <main>
        <Body state={state} onRetry={retry} list={list} />
      </main>
    </>
  )
}

/** "2 need you · 1 error · 1 new reply" over every shared session, whatever the filters. */
function Summary({ data, dimmed }: { data: ViewerData; dimmed: boolean }) {
  const text = summaryText(statusView(data.frame.status, NO_FILTERS).counts)
  if (!text) return null
  return <p className={dimmed ? 'summary dimmed' : 'summary'}>{text}</p>
}

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const time = (ms: number) => timeFormat.format(new Date(ms))

/** The state word is the live region, so a screen reader hears changes, not every heartbeat. */
function Pill({ state }: { state: ViewerState }) {
  const pill = pillOf(state)
  if (!pill) return null
  return (
    <p className={`pill pill-${pill.tone}`}>
      <span role="status">{pill.label}</span>
      {pill.detail && <span> · {pill.detail}</span>}
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
      return { label: 'Live', detail: `checked ${time(state.data.lastSentAt)}`, tone: 'live' }
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

type ListState = { filters: Filters; onFilters: (filters: Filters) => void; checkedAt: number }

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

function defaultNow(): number {
  return performance.now()
}
