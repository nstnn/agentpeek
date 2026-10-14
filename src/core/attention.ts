import type {
  Session,
  SessionActivity,
  SessionAttention,
  SessionLocalState,
  SessionReply
} from './session'
import { sessionKeyToString } from './session'

export interface AttentionInput {
  activity: SessionActivity
  lastReply: SessionReply | null
  local: SessionLocalState
  /** The tool's first-start baseline, from `establishBaseline`. */
  baselineAt: number
}

/** Decides why a session needs attention (REQ-004). */
export function deriveAttention(input: AttentionInput): SessionAttention {
  const { lastReply } = input
  const unread = lastReply !== null && isUnread(lastReply, input.local, input.baselineAt)
  return {
    // Waiting ends only when the tool's status changes. Viewing the session does not clear it.
    waiting: input.activity.state === 'waiting',
    newReply: unread && !lastReply.isError,
    error: unread && lastReply.isError
  }
}

function isUnread(reply: SessionReply, local: SessionLocalState, baselineAt: number): boolean {
  // A newer turn started in the tool, so the user has seen this reply or error there.
  if (reply.newerTurnStarted) return false
  // It finished before AgentPeek first read this tool.
  if (reply.completedAt <= baselineAt) return false
  const cursor = reply.isError ? local.acknowledgedErrorCursor : local.seenCursor
  return reply.cursor !== cursor
}

export function needsAttention(attention: SessionAttention): boolean {
  return attention.waiting || attention.newReply || attention.error
}

/** Counts the sessions that need attention. Each session counts once, whatever its reasons. */
export function countNeedingAttention(sessions: readonly Session[]): number {
  const keys = new Set<string>()
  for (const session of sessions) {
    if (needsAttention(session.attention)) keys.add(sessionKeyToString(session.key))
  }
  return keys.size
}

/**
 * Marks a session's latest reply as seen, or its latest error as acknowledged. Used for Mark Read
 * and when the session's detail is shown in the focused window.
 */
export function markRead(
  local: SessionLocalState,
  lastReply: SessionReply | null
): SessionLocalState {
  if (lastReply === null) return local
  return lastReply.isError
    ? { ...local, acknowledgedErrorCursor: lastReply.cursor }
    : { ...local, seenCursor: lastReply.cursor }
}

/**
 * The first-start baseline (REQ-004). The first time AgentPeek reads a tool, every reply and error
 * that tool finished up to that moment counts as read. Returns the saved baseline, or `now` when
 * there is none yet; the caller saves the result.
 */
export function establishBaseline(saved: number | undefined, now: number): number {
  return saved ?? now
}
