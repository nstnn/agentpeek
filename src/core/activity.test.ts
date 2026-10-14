import { describe, expect, it } from 'vitest'
import { CODEX_QUIET_LIMIT_MS, deriveActivity, looksOpen } from './activity'
import type { ClaudeRegistryFacts, SessionActivity, TurnFacts } from './session'

// Synthetic times only. The clock is passed in, so every test controls "now".
const NOW = Date.UTC(2026, 0, 15, 12, 0, 0)
const MINUTE = 60 * 1000

function activity(
  turn: TurnFacts,
  options: { lastActivityAt?: number; previous?: SessionActivity; now?: number } = {}
): SessionActivity {
  return deriveActivity({
    turn,
    lastActivityAt: options.lastActivityAt ?? NOW - MINUTE,
    previous: options.previous,
    now: options.now ?? NOW
  })
}

function claude(registry: Partial<ClaudeRegistryFacts> | null): TurnFacts {
  if (registry === null) return { kind: 'claude', registry: null }
  return {
    kind: 'claude',
    registry: { status: 'idle', waitingFor: null, ownerAlive: true, ...registry }
  }
}

function codex(lastTurnEvent: 'started' | 'ended' | null, appRunning = true): TurnFacts {
  return { kind: 'codex', lastTurnEvent, appRunning }
}

describe('deriveActivity for Claude Code', () => {
  it('shows a busy registry with a live owner as Running', () => {
    expect(activity(claude({ status: 'busy' }))).toEqual({ state: 'running' })
  })

  it.each([
    'permission prompt',
    'input needed',
    'dialog open',
    'sandbox request',
    'worker request',
    'goal proposal',
    'a value from a newer version'
  ])('shows a waiting registry as Waiting for you, with the detail "%s"', (waitingFor) => {
    expect(activity(claude({ status: 'waiting', waitingFor }))).toEqual({
      state: 'waiting',
      waitingFor
    })
  })

  it('keeps Waiting for you when the registry gives no detail', () => {
    expect(activity(claude({ status: 'waiting', waitingFor: null }))).toEqual({
      state: 'waiting',
      waitingFor: null
    })
  })

  it('shows an idle registry as Idle, whether or not its process is alive', () => {
    expect(activity(claude({ status: 'idle', ownerAlive: true }))).toEqual({ state: 'idle' })
    expect(activity(claude({ status: 'idle', ownerAlive: false }))).toEqual({ state: 'idle' })
  })

  it('shows a catalog entry without a registry file as Idle', () => {
    expect(activity(claude(null))).toEqual({ state: 'idle' })
  })

  it('shows a busy or waiting registry whose process is gone as Unknown', () => {
    const processEnded = { state: 'unknown', reason: 'process-ended' }
    expect(activity(claude({ status: 'busy', ownerAlive: false }))).toEqual(processEnded)
    expect(
      activity(claude({ status: 'waiting', waitingFor: 'input needed', ownerAlive: false }))
    ).toEqual(processEnded)
  })

  it('keeps the previous activity while a registry file has no status yet', () => {
    const starting = claude({ status: null })
    const previousStates: SessionActivity[] = [
      { state: 'running' },
      { state: 'waiting', waitingFor: 'permission prompt' },
      { state: 'unknown', reason: 'process-ended' }
    ]
    for (const previous of previousStates) {
      expect(activity(starting, { previous })).toEqual(previous)
    }
  })

  it('shows a new registry file without a status as Idle', () => {
    expect(activity(claude({ status: null }))).toEqual({ state: 'idle' })
  })
})

describe('deriveActivity for Codex', () => {
  it('shows an open turn as Running while the app runs and the rollout keeps changing', () => {
    expect(activity(codex('started'))).toEqual({ state: 'running' })
  })

  it('shows an open turn as Unknown when the Codex app is not running', () => {
    expect(activity(codex('started', false))).toEqual({
      state: 'unknown',
      reason: 'app-not-running'
    })
  })

  it('shows an open turn as Unknown after 30 quiet minutes', () => {
    const lastActivityAt = NOW - CODEX_QUIET_LIMIT_MS
    const turn = codex('started')
    expect(activity(turn, { lastActivityAt, now: NOW - 1 })).toEqual({ state: 'running' })
    expect(activity(turn, { lastActivityAt, now: NOW })).toEqual({
      state: 'unknown',
      reason: 'quiet'
    })
    expect(activity(turn, { lastActivityAt, now: NOW + 60 * MINUTE })).toEqual({
      state: 'unknown',
      reason: 'quiet'
    })
  })

  it('reports a stopped app before a quiet rollout', () => {
    expect(activity(codex('started', false), { lastActivityAt: NOW - 90 * MINUTE })).toEqual({
      state: 'unknown',
      reason: 'app-not-running'
    })
  })

  it('shows a finished or aborted turn as Idle, even when the app is not running', () => {
    expect(activity(codex('ended'))).toEqual({ state: 'idle' })
    expect(activity(codex('ended', false), { lastActivityAt: NOW - 90 * MINUTE })).toEqual({
      state: 'idle'
    })
  })

  it('shows a rollout without any turn event in its tail as Unknown', () => {
    expect(activity(codex(null))).toEqual({ state: 'unknown', reason: 'unreadable' })
  })
})

describe('deriveActivity for an unreadable source', () => {
  it('shows a missing or unreadable file as Unknown', () => {
    expect(activity({ kind: 'unreadable' })).toEqual({ state: 'unknown', reason: 'unreadable' })
  })

  it('shows an unrecognized format as Unknown', () => {
    expect(activity({ kind: 'unsupported' })).toEqual({ state: 'unknown', reason: 'unsupported' })
  })
})

describe('looksOpen', () => {
  it('is true only for turns that looked open', () => {
    expect(looksOpen('process-ended')).toBe(true)
    expect(looksOpen('app-not-running')).toBe(true)
    expect(looksOpen('quiet')).toBe(true)
    expect(looksOpen('unreadable')).toBe(false)
    expect(looksOpen('unsupported')).toBe(false)
  })
})
