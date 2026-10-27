import type { SessionReply } from '../session'
import type { ClaudeRecord } from './records'

// What AgentPeek knows from one Claude Code transcript. It is built from the tail the source reads
// first, then updated with each batch of lines Claude Code appends, so the source never reads a
// transcript twice. The session's activity does not come from here: the registry reports it.

export interface ClaudeTranscriptState {
  /** The latest turn that ended with a final reply or an API error (see `SessionReply`). */
  lastReply: SessionReply | null
  /** The last `custom-title` record's title, or null. */
  customTitle: string | null
  /** The time of the newest record read that has a time, or null when none was read. */
  lastRecordAt: number | null
  /** The Claude Code version of the newest record that names one. */
  version: string | null
}

export const EMPTY_CLAUDE_TRANSCRIPT_STATE: ClaudeTranscriptState = {
  lastReply: null,
  customTitle: null,
  lastRecordAt: null,
  version: null
}

/** Applies records, oldest first, to the state. */
export function foldClaudeRecords(
  state: ClaudeTranscriptState,
  records: readonly ClaudeRecord[]
): ClaudeTranscriptState {
  let { lastReply, customTitle, lastRecordAt, version } = state
  for (const record of records) {
    if (record.at !== null) {
      lastRecordAt = lastRecordAt === null ? record.at : Math.max(lastRecordAt, record.at)
    }
    version = record.version ?? version
    switch (record.kind) {
      case 'prompt':
        // A newer turn means the user has seen the previous reply or error in Claude (TASK-004).
        if (lastReply !== null && !lastReply.newerTurnStarted) {
          lastReply = { ...lastReply, newerTurnStarted: true }
        }
        break
      case 'assistant':
        // A final reply's records all have `end_turn`; its last record is the cursor.
        if (record.endsTurn && record.uuid !== null) {
          lastReply = {
            cursor: record.uuid,
            completedAt: record.at,
            isError: false,
            errorCode: null,
            newerTurnStarted: false
          }
        }
        break
      case 'api-error':
        if (record.uuid !== null) {
          lastReply = {
            cursor: record.uuid,
            completedAt: record.at,
            isError: true,
            errorCode: record.errorCode,
            newerTurnStarted: false
          }
        }
        break
      case 'custom-title':
        customTitle = record.title
        break
      case 'interrupt':
      case 'tool-result':
      case 'other':
        // A stop or a denied permission ends the turn with no reply and no error (TASK-003).
        break
    }
  }
  return { lastReply, customTitle, lastRecordAt, version }
}

/**
 * Whether a record shows where a turn starts or ends. The source reads further back until its tail
 * holds one: before it, every earlier reply is followed by a prompt, so it no longer counts.
 */
export function marksTurn(record: ClaudeRecord): boolean {
  switch (record.kind) {
    case 'prompt':
    case 'api-error':
    case 'interrupt':
      return true
    case 'assistant':
      return record.endsTurn
    case 'custom-title':
    case 'tool-result':
    case 'other':
      return false
  }
}
