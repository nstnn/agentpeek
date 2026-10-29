import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createConnection, type Connection, type ViewerData, type ViewerState } from './connection'

// The Remote View page that a browser on the owner's tailnet opens. TASK-017 owns the connection
// entry: connecting, live, reconnecting, connection lost, too many pages, off, and the final
// not-allowed, wrong-address and update-needed states, with the TASK-002 copy. The session list
// (TASK-018) replaces `StatusSummary`.

export interface AppProps {
  /** Tests pass their own; the page uses the browser's. */
  fetch?: typeof fetch
  random?: () => number
}

export function App({ fetch: fetchImpl, random }: AppProps) {
  const [state, setState] = useState<ViewerState>({ kind: 'connecting' })
  const connection = useRef<Connection | null>(null)

  useEffect(() => {
    const created = createConnection({
      fetch: fetchImpl ?? window.fetch.bind(window),
      random,
      onChange: setState
    })
    connection.current = created
    created.start()
    return () => created.stop()
  }, [fetchImpl, random])

  const retry = () => connection.current?.retryNow()
  return (
    <>
      <header>
        <h1>AgentPeek</h1>
        <Pill state={state} />
      </header>
      <main>
        <Body state={state} onRetry={retry} />
      </main>
    </>
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

function Body({ state, onRetry }: { state: ViewerState; onRetry: () => void }) {
  switch (state.kind) {
    case 'connecting':
      return <Skeleton />
    case 'live':
      return <StatusSummary data={state.data} />
    case 'reconnecting':
      return state.data ? <StatusSummary data={state.data} dimmed /> : <Skeleton />
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
          {state.data && <StatusSummary data={state.data} dimmed />}
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
          {state.data && <StatusSummary data={state.data} dimmed />}
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

/**
 * A stand-in for the session list (TASK-018): the shared projects and how many sessions each has.
 * Dimmed data is never live; its pill says "showing data from <time>".
 */
function StatusSummary({ data, dimmed = false }: { data: ViewerData; dimmed?: boolean }) {
  const { projects, omitted } = data.frame.status
  return (
    <div className={dimmed ? 'status dimmed' : 'status'} data-testid="status">
      {projects.length === 0 ? (
        <p>
          No projects are shared. On the Mac, open AgentPeek → Settings → Remote View → Add Project.
        </p>
      ) : (
        projects.map((project, index) => (
          <section key={index}>
            <h2>{project.label}</h2>
            <p>
              {project.sessions.length === 0
                ? 'No sessions.'
                : project.sessions.length === 1
                  ? '1 session'
                  : `${project.sessions.length} sessions`}
            </p>
          </section>
        ))
      )}
      {(omitted.projects > 0 || omitted.sessions > 0) && (
        <p className="hint">
          Not everything fits: {omitted.projects} projects and {omitted.sessions} sessions left out.
        </p>
      )}
    </div>
  )
}
