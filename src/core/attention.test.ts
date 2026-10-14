import { describe, expect, it } from 'vitest'
import {
  countNeedingAttention,
  deriveAttention,
  establishBaseline,
  markRead,
  needsAttention
} from './attention'
import type {
  Session,
  SessionActivity,
  SessionAttention,
  SessionLocalState,
  SessionReply
} from './session'
import { EMPTY_LOCAL_STATE } from './session'

// Synthetic IDs and times only.
const BASELINE = Date.UTC(2026, 0, 15, 9, 0, 0)
const LATER = BASELINE + 60 * 60 * 1000
const IDLE: SessionActivity = { state: 'idle' }
const NO_ATTENTION: SessionAttention = { waiting: false, newReply: false, error: false }

function reply(cursor: string, overrides: Partial<SessionReply> = {}): SessionReply {
  return {
    cursor,
    completedAt: LATER,
    isError: false,
    errorCode: null,
    newerTurnStarted: false,
    ...overrides
  }
}

function error(cursor: string, errorCode: string, overrides: Partial<SessionReply> = {}) {
  return reply(cursor, { isError: true, errorCode, ...overrides })
}

function attention(
  lastReply: SessionReply | null,
  local: Partial<SessionLocalState> = {},
  activity: SessionActivity = IDLE
): SessionAttention {
  return deriveAttention({
    activity,
    lastReply,
    local: { ...EMPTY_LOCAL_STATE, ...local },
    baselineAt: BASELINE
  })
}

describe('deriveAttention', () => {
  it('flags a session that is waiting for the user', () => {
    expect(attention(null, {}, { state: 'waiting', waitingFor: 'permission prompt' })).toEqual({
      ...NO_ATTENTION,
      waiting: true
    })
  })

  it('flags a reply after the seen cursor as new', () => {
    expect(attention(reply('turn-2'), { seenCursor: 'turn-1' })).toEqual({
      ...NO_ATTENTION,
      newReply: true
    })
    expect(attention(reply('turn-1'))).toEqual({ ...NO_ATTENTION, newReply: true })
  })

  it('does not flag the reply at the seen cursor', () => {
    expect(attention(reply('turn-1'), { seenCursor: 'turn-1' })).toEqual(NO_ATTENTION)
  })

  it('flags an error until it is acknowledged', () => {
    const failed = error('turn-3', 'server_overloaded')
    expect(attention(failed)).toEqual({ ...NO_ATTENTION, error: true })
    expect(attention(failed, { acknowledgedErrorCursor: 'turn-3' })).toEqual(NO_ATTENTION)
  })

  it('flags a Claude Code API error', () => {
    expect(attention(error('record-9', 'rate_limit'))).toEqual({ ...NO_ATTENTION, error: true })
  })

  it('does not treat a seen reply cursor as an error acknowledgement', () => {
    expect(attention(error('turn-3', 'server_overloaded'), { seenCursor: 'turn-3' })).toEqual({
      ...NO_ATTENTION,
      error: true
    })
  })

  it('replaces an error with the newer reply that followed it', () => {
    // The source reports only the latest outcome. The error's turn was followed by a newer turn,
    // which finished with a reply.
    expect(attention(error('turn-1', 'server_overloaded'))).toEqual({
      ...NO_ATTENTION,
      error: true
    })
    expect(attention(reply('turn-2'))).toEqual({ ...NO_ATTENTION, newReply: true })
  })

  it('clears a reply or an error once a newer turn starts in the tool', () => {
    expect(attention(reply('turn-1', { newerTurnStarted: true }))).toEqual(NO_ATTENTION)
    expect(attention(error('turn-1', 'server_overloaded', { newerTurnStarted: true }))).toEqual(
      NO_ATTENTION
    )
  })

  it('never flags a stopped turn or a denied permission', () => {
    // Neither writes a reply or an error. A stop or a denial after an unseen reply still means a
    // newer turn started, so that reply clears.
    expect(attention(null)).toEqual(NO_ATTENTION)
    expect(attention(reply('turn-1', { newerTurnStarted: true }))).toEqual(NO_ATTENTION)
  })

  it('does not flag replies or errors that finished before the baseline', () => {
    expect(attention(reply('turn-1', { completedAt: BASELINE - 1 }))).toEqual(NO_ATTENTION)
    expect(attention(reply('turn-1', { completedAt: BASELINE }))).toEqual(NO_ATTENTION)
    expect(attention(error('turn-1', 'rate_limit', { completedAt: BASELINE }))).toEqual(
      NO_ATTENTION
    )
    expect(attention(reply('turn-1', { completedAt: BASELINE + 1 }))).toEqual({
      ...NO_ATTENTION,
      newReply: true
    })
  })
})

describe('markRead', () => {
  it('saves a reply as seen and an error as acknowledged', () => {
    expect(markRead(EMPTY_LOCAL_STATE, reply('turn-1'))).toEqual({
      ...EMPTY_LOCAL_STATE,
      seenCursor: 'turn-1'
    })
    expect(markRead(EMPTY_LOCAL_STATE, error('turn-2', 'rate_limit'))).toEqual({
      ...EMPTY_LOCAL_STATE,
      acknowledgedErrorCursor: 'turn-2'
    })
  })

  it('keeps the pin and the other cursor', () => {
    const local = { pinned: true, seenCursor: 'turn-1', acknowledgedErrorCursor: 'turn-0' }
    expect(markRead(local, reply('turn-2'))).toEqual({ ...local, seenCursor: 'turn-2' })
  })

  it('changes nothing when there is no reply', () => {
    expect(markRead(EMPTY_LOCAL_STATE, null)).toBe(EMPTY_LOCAL_STATE)
  })

  it('clears a new reply and an error, but not Waiting for you', () => {
    const waiting: SessionActivity = { state: 'waiting', waitingFor: 'input needed' }
    for (const latest of [reply('turn-1'), error('turn-1', 'rate_limit')]) {
      const local = markRead(EMPTY_LOCAL_STATE, latest)
      expect(attention(latest, local)).toEqual(NO_ATTENTION)
      expect(attention(latest, local, waiting)).toEqual({ ...NO_ATTENTION, waiting: true })
    }
  })
})

describe('establishBaseline', () => {
  it('starts the baseline on the first read and keeps it afterwards', () => {
    expect(establishBaseline(undefined, LATER)).toBe(LATER)
    expect(establishBaseline(BASELINE, LATER)).toBe(BASELINE)
  })
})

describe('needsAttention and countNeedingAttention', () => {
  function session(id: string, attention: SessionAttention): Session {
    return {
      key: { tool: 'claude', id },
      summary: { title: null, workspacePath: null, lastActivityAt: LATER, toolVersion: null },
      activity: IDLE,
      attention,
      lastReply: null,
      pinned: false
    }
  }

  it('is true when any reason applies', () => {
    expect(needsAttention(NO_ATTENTION)).toBe(false)
    expect(needsAttention({ ...NO_ATTENTION, waiting: true })).toBe(true)
    expect(needsAttention({ ...NO_ATTENTION, newReply: true })).toBe(true)
    expect(needsAttention({ ...NO_ATTENTION, error: true })).toBe(true)
  })

  it('counts each session once, however many reasons apply', () => {
    const sessions = [
      session('a', { waiting: true, newReply: false, error: true }),
      session('b', { ...NO_ATTENTION, newReply: true }),
      session('c', NO_ATTENTION)
    ]
    expect(countNeedingAttention(sessions)).toBe(2)
  })

  it('counts a session listed twice once', () => {
    const flagged = session('a', { ...NO_ATTENTION, error: true })
    expect(countNeedingAttention([flagged, { ...flagged }])).toBe(1)
    expect(countNeedingAttention([flagged, { ...flagged, key: { tool: 'codex', id: 'a' } }])).toBe(
      2
    )
  })
})
