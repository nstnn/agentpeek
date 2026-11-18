import { deriveActivity } from './activity'
import { deriveAttention } from './attention'
import type { ToolHealth } from './health'
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
    ...(facts.appSessionId ? { appSessionId: facts.appSessionId } : {}),
    summary: facts.summary,
    activity,
    attention,
    lastReply: facts.lastReply,
    pinned: local.pinned
  }
}

/**
 * Applies the tool's health to a session's facts. When the tool writes its files in a format
 * AgentPeek does not recognize ("Unsupported format"), none of its facts can be trusted: each of
 * its sessions shows "Unknown · Unsupported format", and nothing read from it counts as a new reply
 * or an error. The source still lists the sessions it could read, so the titles stay.
 */
export function factsUnderHealth(facts: SessionFacts, health: ToolHealth): SessionFacts {
  if (health.state !== 'unsupported') return facts
  return { ...facts, turn: { kind: 'unsupported' }, lastReply: null }
}
