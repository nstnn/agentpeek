import type { SessionFacts, TurnFacts } from '../session'
import type { ClaudeCatalogEntry, ClaudeRegistryEntry } from './records'
import type { ClaudeTranscriptState } from './transcript-state'

/**
 * How the last read of a transcript went:
 * - `read`: it was read;
 * - `unreadable`: it could not be read (no permission, refused by the access gate, a read error);
 * - `unsupported`: it was read, but no line was a record AgentPeek knows.
 */
export type ClaudeFileStatus = 'read' | 'unreadable' | 'unsupported'

export interface ClaudeFactsInput {
  sessionId: string
  /** The session's Desktop catalog entry, or null for a session only the registry lists. */
  catalog: ClaudeCatalogEntry | null
  /** The session's registry entry, or null when its process is not running. */
  registry: ClaudeRegistryEntry | null
  /**
   * Whether the registry folder could be listed. When it could not, no session's activity is
   * known: a missing registry entry no longer means the process is not running.
   */
  registryReadable: boolean
  /**
   * Whether the registry's process still runs (TASK-002). It is only checked, and only matters,
   * while the registry says `busy` or `waiting`.
   */
  ownerAlive: boolean
  transcript: ClaudeTranscriptState
  transcriptStatus: ClaudeFileStatus
  /** The transcript's modification time, used when no other time is known. */
  transcriptModifiedAt: number
}

/** The facts the Claude Code source reports for one session (see "Session model (TASK-005)"). */
export function claudeSessionFacts(input: ClaudeFactsInput): SessionFacts {
  const { catalog, registry, transcript } = input
  return {
    key: { tool: 'claude', id: input.sessionId },
    summary: {
      // The plan's title rule: the catalog title, then the registry name, then the custom title.
      title: catalog?.title ?? registry?.name ?? transcript.customTitle,
      workspacePath: catalog?.cwd ?? registry?.cwd ?? null,
      lastActivityAt: claudeLastActivityAt(input),
      toolVersion: registry?.version ?? transcript.version
    },
    turn: turnFacts(input),
    lastReply: transcript.lastReply
  }
}

/**
 * The session's last activity: the newer of the catalog's activity time and the transcript's last
 * record time.
 */
export function claudeLastActivityAt(
  input: Pick<ClaudeFactsInput, 'catalog' | 'transcript' | 'transcriptModifiedAt'>
): number {
  const times = [input.catalog?.lastActivityAt, input.transcript.lastRecordAt].filter(
    (time) => typeof time === 'number'
  )
  return times.length > 0 ? Math.max(...times) : input.transcriptModifiedAt
}

function turnFacts(input: ClaudeFactsInput): TurnFacts {
  const { registry } = input
  if (input.transcriptStatus === 'unreadable' || !input.registryReadable) {
    return { kind: 'unreadable' }
  }
  if (input.transcriptStatus === 'unsupported') return { kind: 'unsupported' }
  if (registry === null) return { kind: 'claude', registry: null }
  if (registry.status === 'unrecognized') return { kind: 'unsupported' }
  return {
    kind: 'claude',
    registry: {
      status: registry.status,
      waitingFor: registry.status === 'waiting' ? registry.waitingFor : null,
      ownerAlive: input.ownerAlive
    }
  }
}
