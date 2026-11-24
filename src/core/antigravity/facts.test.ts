import { describe, expect, it } from 'vitest'
import type { SessionReply } from '../session'
import { type AntigravityFactsInput, antigravitySessionFacts } from './facts'
import { conversationId, T0 } from './test-records'

// Synthetic values only.
const REPLY: SessionReply = {
  cursor: '3:2026-01-15T09:00:03.000Z',
  completedAt: T0,
  isError: false,
  errorCode: null,
  newerTurnStarted: false
}

function input(change: Partial<AntigravityFactsInput> = {}): AntigravityFactsInput {
  return {
    conversationId: conversationId(1),
    summary: { title: null, workspacePath: null, lastActivityAt: T0, toolVersion: null },
    fileStatus: 'read',
    lastTurnStep: 'ended',
    lastReply: REPLY,
    appRunning: true,
    ...change
  }
}

describe('antigravitySessionFacts', () => {
  it('keys the session by tool and conversation ID and keeps a read transcript’s facts', () => {
    expect(antigravitySessionFacts(input({ lastTurnStep: 'open', appRunning: false }))).toEqual({
      key: { tool: 'antigravity', id: conversationId(1) },
      summary: { title: null, workspacePath: null, lastActivityAt: T0, toolVersion: null },
      turn: { kind: 'antigravity', lastTurnStep: 'open', appRunning: false },
      lastReply: REPLY
    })
  })

  it('maps unreadable and unsupported transcripts to those turn facts, with no reply', () => {
    for (const fileStatus of ['unreadable', 'unsupported'] as const) {
      const facts = antigravitySessionFacts(input({ fileStatus }))
      expect(facts.turn).toEqual({ kind: fileStatus })
      expect(facts.lastReply).toBeNull()
    }
  })
})
