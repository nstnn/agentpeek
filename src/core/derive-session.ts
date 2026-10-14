import { deriveActivity } from './activity'
import { deriveAttention } from './attention'
import type { Session, SessionActivity, SessionFacts, SessionLocalState } from './session'

export interface DeriveSessionInput {
  facts: SessionFacts
  local: SessionLocalState
  /** The tool's first-start baseline, from `establishBaseline`. */
  baselineAt: number
  /** The activity this session had in the previous snapshot, if any. */
  previousActivity?: SessionActivity
  now: number
}

/** Turns a source's facts and the local state into the session AgentPeek shows. */
export function deriveSession(input: DeriveSessionInput): Session {
  const { facts, local } = input
  const activity = deriveActivity({
    turn: facts.turn,
    lastActivityAt: facts.summary.lastActivityAt,
    previous: input.previousActivity,
    now: input.now
  })
  const attention = deriveAttention({
    activity,
    lastReply: facts.lastReply,
    local,
    baselineAt: input.baselineAt
  })
  return {
    key: facts.key,
    summary: facts.summary,
    activity,
    attention,
    lastReply: facts.lastReply,
    pinned: local.pinned
  }
}
