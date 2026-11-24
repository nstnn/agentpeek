import type { SessionFacts, SessionReply, SessionSummary, TurnFacts } from '../session'

/**
 * How the last read of a transcript went:
 * - `read`: it was read;
 * - `unreadable`: it could not be read (no permission, refused by the access gate, a read error);
 * - `unsupported`: it was read, but no step had the fields AgentPeek knows.
 */
export type AntigravityFileStatus = 'read' | 'unreadable' | 'unsupported'

export interface AntigravityFactsInput {
  conversationId: string
  summary: SessionSummary
  fileStatus: AntigravityFileStatus
  /** See `AntigravityTurnState.lastTurnStep`. */
  lastTurnStep: 'open' | 'ended' | null
  lastReply: SessionReply | null
  /** Whether Antigravity Desktop is running. */
  appRunning: boolean
}

/** The facts the Antigravity source reports for one conversation (TASK-005). */
export function antigravitySessionFacts(input: AntigravityFactsInput): SessionFacts {
  const readable = input.fileStatus === 'read'
  return {
    key: { tool: 'antigravity', id: input.conversationId },
    summary: input.summary,
    turn: turnFacts(input),
    // A file that could not be read, or was not understood, never announces a reply.
    lastReply: readable ? input.lastReply : null
  }
}

function turnFacts(input: AntigravityFactsInput): TurnFacts {
  switch (input.fileStatus) {
    case 'unreadable':
      return { kind: 'unreadable' }
    case 'unsupported':
      return { kind: 'unsupported' }
    case 'read':
      return { kind: 'antigravity', lastTurnStep: input.lastTurnStep, appRunning: input.appRunning }
  }
}
