import type {
  ClaudeTurnFacts,
  CodexTurnFacts,
  SessionActivity,
  TurnFacts,
  UnknownReason
} from './session'

/** A Codex turn with no rollout write for this long is no longer trusted as Running (TASK-003). */
export const CODEX_QUIET_LIMIT_MS = 30 * 60 * 1000

export interface ActivityInput {
  turn: TurnFacts
  /** The session's last activity time, from its summary. */
  lastActivityAt: number
  /** The activity derived last time, if any. Used while a Claude Code registry has no status yet. */
  previous: SessionActivity | undefined
  /** The current time. Passed in, so tests can control the clock. */
  now: number
}

/** Maps a session's turn facts to exactly one activity state ("State mapping (TASK-003)"). */
export function deriveActivity(input: ActivityInput): SessionActivity {
  const { turn } = input
  switch (turn.kind) {
    case 'claude':
      return claudeActivity(turn, input.previous)
    case 'codex':
      return codexActivity(turn, input.lastActivityAt, input.now)
    case 'unreadable':
    case 'unsupported':
      return unknown(turn.kind)
  }
}

function claudeActivity(
  turn: ClaudeTurnFacts,
  previous: SessionActivity | undefined
): SessionActivity {
  const { registry } = turn
  // Claude.app removes idle sessions' registry files while it runs, so no file means Idle.
  if (registry === null) return { state: 'idle' }

  switch (registry.status) {
    case null:
      // A new registry file has no status for its first fraction of a second. Keep what we had.
      return previous ?? { state: 'idle' }
    case 'idle':
      return { state: 'idle' }
    case 'busy':
      return registry.ownerAlive ? { state: 'running' } : unknown('process-ended')
    case 'waiting':
      return registry.ownerAlive
        ? { state: 'waiting', waitingFor: registry.waitingFor }
        : unknown('process-ended')
  }
}

function codexActivity(turn: CodexTurnFacts, lastActivityAt: number, now: number): SessionActivity {
  switch (turn.lastTurnEvent) {
    case null:
      return unknown('unreadable')
    case 'ended':
      return { state: 'idle' }
    case 'started':
      // Codex has no registry, so an open turn is trusted only while its app runs and keeps writing.
      if (!turn.appRunning) return unknown('app-not-running')
      if (now - lastActivityAt >= CODEX_QUIET_LIMIT_MS) return unknown('quiet')
      return { state: 'running' }
  }
}

function unknown(reason: UnknownReason): SessionActivity {
  return { state: 'unknown', reason }
}

/**
 * True when an Unknown state comes from a turn that looked open, so the session belongs in the
 * Active view's Unknown group. Unreadable and unsupported files do not.
 */
export function looksOpen(reason: UnknownReason): boolean {
  return reason === 'process-ended' || reason === 'app-not-running' || reason === 'quiet'
}
