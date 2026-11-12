import type { SessionReply } from '../session'
import type { ToolUsageLimits } from '../usage'
import type { CodexRecord } from './records'

// What AgentPeek knows about one rollout's turns. It is built from the tail the source reads first,
// then updated with each batch of lines Codex appends, so the source never reads a rollout twice.

export interface CodexTurnState {
  /**
   * The last turn event: `started` for `task_started`, `ended` for `task_complete` or
   * `turn_aborted`, and null when none was read.
   */
  lastTurnEvent: 'started' | 'ended' | null
  /** The latest turn that ended with a final reply or an error (see `SessionReply`). */
  lastReply: SessionReply | null
  /** The time of the newest record read, or null when none was read. */
  lastRecordAt: number | null
  /** The newest usage limits a `token_count` event recorded, or null when none was read. */
  usageLimits: ToolUsageLimits | null
}

export const EMPTY_CODEX_TURN_STATE: CodexTurnState = {
  lastTurnEvent: null,
  lastReply: null,
  lastRecordAt: null,
  usageLimits: null
}

/** Applies records, oldest first, to the state. */
export function foldCodexRecords(
  state: CodexTurnState,
  records: readonly CodexRecord[]
): CodexTurnState {
  let { lastTurnEvent, lastReply, lastRecordAt, usageLimits } = state
  for (const record of records) {
    lastRecordAt = lastRecordAt === null ? record.at : Math.max(lastRecordAt, record.at)
    switch (record.kind) {
      case 'turn-started':
        lastTurnEvent = 'started'
        // A newer turn means the user has seen the previous reply or error in Codex (TASK-004).
        if (lastReply !== null && !lastReply.newerTurnStarted) {
          lastReply = { ...lastReply, newerTurnStarted: true }
        }
        break
      case 'turn-completed':
        lastTurnEvent = 'ended'
        if (record.outcome !== null) {
          lastReply = {
            cursor: record.outcome.turnId,
            completedAt: record.at,
            isError: record.outcome.isError,
            errorCode: record.outcome.errorCode,
            newerTurnStarted: false
          }
        }
        break
      case 'turn-aborted':
        lastTurnEvent = 'ended'
        break
      case 'usage-limits':
        if (usageLimits === null || record.at >= usageLimits.observedAt) {
          usageLimits = {
            observedAt: record.at,
            windows: record.windows,
            limitReached: record.limitReached
          }
        }
        break
    }
  }
  return { lastTurnEvent, lastReply, lastRecordAt, usageLimits }
}
