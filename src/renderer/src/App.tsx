import { useEffect, useState, type JSX } from 'react'
import type { AppSnapshot } from '../../shared/api'

export function App(): JSX.Element {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let active = true
    let received = false
    const unsubscribe = window.agentpeek.onSnapshot((next) => {
      received = true
      if (active) setSnapshot(next)
    })
    void window.agentpeek
      .getSnapshot()
      .then((next) => {
        if (active && !received) setSnapshot(next)
      })
      .catch(() => {
        if (active && !received) setFailed(true)
      })
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  return (
    <div className="app-shell">
      {snapshot?.fixture && (
        <p className="fixture-banner" role="status">
          Fixture data · AgentPeek is showing synthetic sessions from {snapshot.fixtureHome}, not
          your real sessions.
        </p>
      )}
      <main className="placeholder">
        <h1>AgentPeek</h1>
        <p role="status">
          {snapshot
            ? `${snapshot.sessions.length} ${snapshot.sessions.length === 1 ? 'session' : 'sessions'}`
            : failed
              ? "Couldn't load sessions"
              : 'Checking sessions…'}
        </p>
      </main>
    </div>
  )
}
