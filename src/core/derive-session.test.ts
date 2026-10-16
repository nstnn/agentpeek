import { describe, expect, it } from 'vitest'
import { CODEX_QUIET_LIMIT_MS } from './activity'
import { establishBaseline, markRead } from './attention'
import { deriveSession, factsUnderHealth } from './derive-session'
import type { SessionFacts, SessionLocalState, SessionReply } from './session'
import { EMPTY_LOCAL_STATE } from './session'

// Synthetic IDs, paths, and times only. Each scenario walks through launches of AgentPeek by
// moving the injected clock forward.
const FIRST_LAUNCH = Date.UTC(2026, 0, 15, 9, 0, 0)
const HOUR = 60 * 60 * 1000

function codexFacts(lastReply: SessionReply | null, lastActivityAt: number): SessionFacts {
  return {
    key: { tool: 'codex', id: 'thread-a' },
    summary: {
      title: 'Synthetic thread',
      workspacePath: '/fixture/project',
      lastActivityAt,
      toolVersion: '0.0.0-fixture'
    },
    turn: { kind: 'codex', lastTurnEvent: 'ended', appRunning: true },
    lastReply
  }
}

function finished(cursor: string, completedAt: number): SessionReply {
  return { cursor, completedAt, isError: false, errorCode: null, newerTurnStarted: false }
}

describe('deriveSession', () => {
  it('copies the key, summary, reply, and pin into the session', () => {
    const facts = codexFacts(finished('turn-1', FIRST_LAUNCH + HOUR), FIRST_LAUNCH + HOUR)
    const local: SessionLocalState = { ...EMPTY_LOCAL_STATE, pinned: true }
    const session = deriveSession({ facts, local, baselineAt: FIRST_LAUNCH, now: FIRST_LAUNCH })
    expect(session).toEqual({
      key: facts.key,
      summary: facts.summary,
      activity: { state: 'idle' },
      attention: { waiting: false, newReply: true, error: false },
      lastReply: facts.lastReply,
      pinned: true
    })
  })

  it('treats replies that existed before the first launch as read', () => {
    const baselineAt = establishBaseline(undefined, FIRST_LAUNCH)
    const oldReply = finished('turn-1', FIRST_LAUNCH - 2 * HOUR)
    const facts = codexFacts(oldReply, oldReply.completedAt)
    const session = deriveSession({
      facts,
      local: EMPTY_LOCAL_STATE,
      baselineAt,
      now: FIRST_LAUNCH
    })
    expect(session.attention.newReply).toBe(false)
  })

  it('shows a reply that finished while AgentPeek was closed as new at the next launch', () => {
    // First launch: the user reads turn-1, then quits AgentPeek.
    const baselineAt = establishBaseline(undefined, FIRST_LAUNCH)
    const turn1 = finished('turn-1', FIRST_LAUNCH + HOUR)
    let local = markRead(EMPTY_LOCAL_STATE, turn1)

    // While AgentPeek is closed, turn-2 finishes. At the next launch the baseline is kept.
    const nextLaunch = FIRST_LAUNCH + 5 * HOUR
    const turn2 = finished('turn-2', FIRST_LAUNCH + 3 * HOUR)
    const savedBaseline = establishBaseline(baselineAt, nextLaunch)
    expect(savedBaseline).toBe(FIRST_LAUNCH)

    const facts = codexFacts(turn2, turn2.completedAt)
    const before = deriveSession({ facts, local, baselineAt: savedBaseline, now: nextLaunch })
    expect(before.attention.newReply).toBe(true)

    local = markRead(local, before.lastReply)
    const after = deriveSession({ facts, local, baselineAt: savedBaseline, now: nextLaunch })
    expect(after.attention.newReply).toBe(false)
  })

  it('keeps the previous activity while a Claude Code registry has no status yet', () => {
    const facts: SessionFacts = {
      ...codexFacts(null, FIRST_LAUNCH),
      key: { tool: 'claude', id: 'session-b' },
      turn: {
        kind: 'claude',
        registry: { status: null, waitingFor: null, ownerAlive: true }
      }
    }
    const session = deriveSession({
      facts,
      local: EMPTY_LOCAL_STATE,
      baselineAt: FIRST_LAUNCH,
      previousActivity: { state: 'running' },
      now: FIRST_LAUNCH
    })
    expect(session.activity).toEqual({ state: 'running' })
  })

  it('turns an open Codex turn Unknown once the clock passes the quiet limit', () => {
    const lastWrite = FIRST_LAUNCH
    const facts: SessionFacts = {
      ...codexFacts(null, lastWrite),
      turn: { kind: 'codex', lastTurnEvent: 'started', appRunning: true }
    }
    const at = (now: number) =>
      deriveSession({ facts, local: EMPTY_LOCAL_STATE, baselineAt: FIRST_LAUNCH, now }).activity
    expect(at(lastWrite + 10 * 60 * 1000)).toEqual({ state: 'running' })
    expect(at(lastWrite + CODEX_QUIET_LIMIT_MS)).toEqual({ state: 'unknown', reason: 'quiet' })
  })
})

describe('factsUnderHealth', () => {
  const reply = finished('turn-1', FIRST_LAUNCH + HOUR)
  const facts = codexFacts(reply, reply.completedAt)

  it('leaves the facts of a tool AgentPeek can read as they are', () => {
    expect(factsUnderHealth(facts, { state: 'connected', lastReadAt: FIRST_LAUNCH })).toBe(facts)
    expect(factsUnderHealth(facts, { state: 'no-access', lastReadAt: null })).toBe(facts)
    expect(factsUnderHealth(facts, { state: 'checking' })).toBe(facts)
  })

  it('shows every session of a tool in an unsupported format as Unknown, with no reply', () => {
    const distrusted = factsUnderHealth(facts, { state: 'unsupported', toolVersion: '9.0.0' })
    expect(distrusted).toEqual({ ...facts, turn: { kind: 'unsupported' }, lastReply: null })
    const session = deriveSession({
      facts: distrusted,
      local: EMPTY_LOCAL_STATE,
      baselineAt: FIRST_LAUNCH,
      now: FIRST_LAUNCH + HOUR
    })
    expect(session.activity).toEqual({ state: 'unknown', reason: 'unsupported' })
    expect(session.attention).toEqual({ waiting: false, newReply: false, error: false })
    expect(session.summary).toBe(facts.summary)
  })
})
