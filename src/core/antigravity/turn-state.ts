import type { SessionReply } from '../session'
import { type AntigravityRecord, isFinalReply, replyCursor } from './records'

// What AgentPeek knows about one Antigravity transcript's turns. It is built from the tail the
// source reads first, then updated with each batch of lines Antigravity appends.
//
// Antigravity writes a step only when it completes, never while it runs (TASK-001). So the last
// step tells whether a turn looks open: a prompt, a step that asked for tools, or a tool result
// leave it open; a final reply or a recognized cancellation ends it. A subagent kill left no
// terminal record at all,
// so an open-looking turn may have stopped; the service decides how long to trust it (DECISION-004).

export interface AntigravityTurnState {
  /**
   * `open` when the last turn step leaves the turn open, `ended` when it ends it, and null when no
   * turn step was read. Unknown step types never change it.
   */
  lastTurnStep: 'open' | 'ended' | null
  /** The latest final reply (see `SessionReply`). Antigravity has no verified turn-level error. */
  lastReply: SessionReply | null
  lastReplyStep: number | null
  /** The time of the newest step read, or null when none was read. */
  lastRecordAt: number | null
  /** The highest `step_index` read. A step at or below it is a replay and is ignored. */
  lastStep: number | null
  /** Newest user prompt read. Subagent transcripts have none (DECISION-001). */
  lastUserStep: number | null
}

export const EMPTY_ANTIGRAVITY_TURN_STATE: AntigravityTurnState = {
  lastTurnStep: null,
  lastReply: null,
  lastReplyStep: null,
  lastRecordAt: null,
  lastStep: null,
  lastUserStep: null
}

/** Applies records, oldest first, to the state. */
export function foldAntigravityRecords(
  state: AntigravityTurnState,
  records: readonly AntigravityRecord[]
): AntigravityTurnState {
  let { lastTurnStep, lastReply, lastReplyStep, lastRecordAt, lastStep, lastUserStep } = state
  for (const record of records) {
    if (record.kind === 'system-message' || record.kind === 'other') continue
    // Steps are appended in order. A step seen again (a replayed or duplicated line) must not move
    // the state back or announce an old reply as new.
    if (lastStep !== null && record.step <= lastStep) continue
    lastStep = record.step
    lastRecordAt = lastRecordAt === null ? record.at : Math.max(lastRecordAt, record.at)
    if (record.status === 'canceled') {
      lastTurnStep = 'ended'
      continue
    }
    switch (record.kind) {
      case 'user-input':
        lastUserStep = record.step
        lastTurnStep = 'open'
        // A newer prompt means the user has seen the previous reply in Antigravity.
        if (lastReply !== null && !lastReply.newerTurnStarted) {
          lastReply = { ...lastReply, newerTurnStarted: true }
        }
        break
      case 'planner-response':
        if (isFinalReply(record)) {
          lastTurnStep = 'ended'
          lastReplyStep = record.step
          lastReply = {
            cursor: replyCursor(record),
            completedAt: record.at,
            ...(record.stamp === null ? { completedAtEstimated: true } : {}),
            isError: false,
            errorCode: null,
            newerTurnStarted: false
          }
        } else if (record.toolCalls !== null) {
          lastTurnStep = 'open'
        }
        break
      case 'tool-result':
        // A failed tool (`ERROR`) fails one step; the turn goes on (TASK-001).
        lastTurnStep = 'open'
        break
    }
  }
  return { lastTurnStep, lastReply, lastReplyStep, lastRecordAt, lastStep, lastUserStep }
}
