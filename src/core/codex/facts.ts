import type { SessionFacts, TurnFacts } from '../session'
import type { CodexThreadMeta } from './records'
import type { CodexTurnState } from './turn-state'

/**
 * How the last read of a rollout went:
 * - `read`: it was read;
 * - `unreadable`: it could not be read (no permission, refused by the access gate, a read error);
 * - `unsupported`: it was read, but no line had the record envelope AgentPeek knows.
 */
export type CodexFileStatus = 'read' | 'unreadable' | 'unsupported'

export interface CodexFactsInput {
  meta: CodexThreadMeta
  /** The thread's name from `session_index.jsonl`, or null. */
  title: string | null
  state: CodexTurnState
  fileStatus: CodexFileStatus
  /** The rollout's modification time, used when no record time is known. */
  fileModifiedAt: number
  appRunning: boolean
}

/** The facts the Codex source reports for one thread (see "Session model (TASK-005)"). */
export function codexSessionFacts(input: CodexFactsInput): SessionFacts {
  const { meta, state } = input
  return {
    key: { tool: 'codex', id: meta.id },
    summary: {
      title: input.title,
      workspacePath: meta.cwd,
      // The last record's `timestamp` tracks the write time within 0.1 s (TASK-003).
      lastActivityAt: state.lastRecordAt ?? input.fileModifiedAt,
      toolVersion: meta.cliVersion
    },
    turn: turnFacts(input),
    lastReply: state.lastReply
  }
}

function turnFacts(input: CodexFactsInput): TurnFacts {
  switch (input.fileStatus) {
    case 'unreadable':
      return { kind: 'unreadable' }
    case 'unsupported':
      return { kind: 'unsupported' }
    case 'read':
      return {
        kind: 'codex',
        lastTurnEvent: input.state.lastTurnEvent,
        appRunning: input.appRunning
      }
  }
}
