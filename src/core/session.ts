import type { AgentTool } from './tools'
import type { SkillMention } from './skill-names'

// The session domain model. Every type here is plain, serializable data (no classes), so the same
// values can cross the IPC bridge later. Every time is in epoch milliseconds.
//
// The flow is: a source (Codex or Claude Code) reads the tool's files and produces `SessionFacts`.
// The reducers in this folder turn those facts, plus AgentPeek's own local state, into a `Session`:
// one activity state and an attention verdict. The rules live in the reducers, never in the sources.

/** Identifies one session: the tool plus the tool's own session ID. */
export interface SessionKey {
  tool: AgentTool
  /** Codex: the thread ID. Claude Code: the CLI session ID (`cliSessionId` / `sessionId`). */
  id: string
}

/** A stable string form of a key, for maps and sets. */
export function sessionKeyToString(key: SessionKey): string {
  return `${key.tool}:${key.id}`
}

/** What the list and the detail header show about a session, besides its state. */
export interface SessionSummary {
  /** The tool's own title, or null when it has none. Never built from message text. */
  title: string | null
  /** The session's working folder, or null when the tool does not record one. */
  workspacePath: string | null
  /** When the tool last wrote anything for this session. */
  lastActivityAt: number
  /** The tool version that wrote the session (Codex `cli_version`, Claude Code `version`), if known. */
  toolVersion: string | null
}

/**
 * What the session's source found out about its current turn, already normalized.
 * `deriveActivity` maps it to one activity state with the rules in "State mapping (TASK-003)".
 */
export type TurnFacts = ClaudeTurnFacts | CodexTurnFacts | UnreadableTurnFacts

export interface ClaudeTurnFacts {
  kind: 'claude'
  /** The session's runtime registry entry (`~/.claude/sessions/<pid>.json`), or null if it has none. */
  registry: ClaudeRegistryFacts | null
}

export interface ClaudeRegistryFacts {
  /** The registry's `status`, or null while the process is starting and has not written one yet. */
  status: 'busy' | 'waiting' | 'idle' | null
  /** The registry's `waitingFor` value (for example `permission prompt`) while it is waiting. */
  waitingFor: string | null
  /** The liveness check on the registry's process (TASK-002): false when the process is gone. */
  ownerAlive: boolean
}

export interface CodexTurnFacts {
  kind: 'codex'
  /**
   * The last turn event in the rollout: `started` for `task_started`, `ended` for `task_complete`
   * or `turn_aborted`, and null when the bounded tail search found no turn event.
   */
  lastTurnEvent: 'started' | 'ended' | null
  /** Whether the Codex app (ChatGPT.app) is running. */
  appRunning: boolean
}

/** The session's file is missing or unreadable, or written in a format AgentPeek does not know. */
export interface UnreadableTurnFacts {
  kind: 'unreadable' | 'unsupported'
}

/**
 * The latest turn that ended with a final reply or an error. Turns that the user stopped, or that
 * ended on a denied permission, never produce one.
 */
export interface SessionReply {
  /** The read cursor: the Codex `turn_id`, or the `uuid` of Claude Code's assistant record. */
  cursor: string
  completedAt: number
  isError: boolean
  /** For an error, the tool's code, such as `server_overloaded` or `rate_limit`. */
  errorCode: string | null
  /**
   * True when a later turn has started in the tool (Codex `task_started`, or a Claude Code user
   * prompt). The user has then evidently seen this reply or error in the tool.
   */
  newerTurnStarted: boolean
}

/** Everything a source reports about one session. */
export interface SessionFacts {
  key: SessionKey
  summary: SessionSummary
  turn: TurnFacts
  lastReply: SessionReply | null
}

/** AgentPeek's own state for a session, kept in its `state.json`. IDs only, never message text. */
export interface SessionLocalState {
  pinned: boolean
  /** The cursor of the last reply the user has seen. */
  seenCursor: string | null
  /** The cursor of the last error the user has acknowledged. */
  acknowledgedErrorCursor: string | null
}

/** The local state of a session AgentPeek has never stored anything for. */
export const EMPTY_LOCAL_STATE: SessionLocalState = {
  pinned: false,
  seenCursor: null,
  acknowledgedErrorCursor: null
}

/**
 * Why a session's activity is Unknown. Each reason has its own label in the interface.
 * - `process-ended`: Claude Code's process for an open turn ended without finishing the turn.
 * - `app-not-running`: a Codex turn looks open, but the Codex app is not running.
 * - `quiet`: a Codex turn looks open, but nothing was written for 30 minutes.
 * - `unreadable`: the session's file is missing or unreadable, or AgentPeek found no turn event in it.
 * - `unsupported`: the session's file is in a format AgentPeek does not recognize.
 */
export type UnknownReason =
  'process-ended' | 'app-not-running' | 'quiet' | 'unreadable' | 'unsupported'

/** Exactly one activity state per session (REQ-003). */
export type SessionActivity =
  | { state: 'running' }
  | { state: 'waiting'; waitingFor: string | null }
  | { state: 'idle' }
  | { state: 'unknown'; reason: UnknownReason }

/** Why a session needs attention (REQ-004). Several can be true; the session still counts once. */
export interface SessionAttention {
  waiting: boolean
  newReply: boolean
  error: boolean
}

/** A session as AgentPeek shows it: the source's facts plus the derived state. */
export interface Session {
  key: SessionKey
  summary: SessionSummary
  activity: SessionActivity
  attention: SessionAttention
  /** Kept so Mark Read knows which cursor to save. */
  lastReply: SessionReply | null
  pinned: boolean
}

/**
 * What a Claude Code call's result says, matched by the call's ID.
 * - `done`: a result that is not an error.
 * - `failed`: a result marked as an error, such as a failed command or a denied permission.
 * - `interrupted`: the user stopped the call.
 * - `pending`: no result yet, and nothing later shows the turn moved on. The detail shows it as
 *   running or waiting only while the session is.
 * - `no-result`: no result, but a later prompt, stop, or turn end shows it will never get one.
 */
export type ToolCallStatus = 'done' | 'failed' | 'interrupted' | 'pending' | 'no-result'

/** On-demand tool input is conversation data, never snapshot or persisted state. */
export interface ToolCallDetail {
  name: string
  at: number
  input: string | null
  inputLength: number
  /** Names found in exec input, not proof of execution. Null for other tools. */
  nestedNames: string[] | null
  /** Claude: one line built from the input, such as a command's description or a file path. */
  summary?: string | null
  /** Claude: `diff` when the input is an edit written as `-` and `+` lines. */
  inputFormat?: 'diff'
  /** Claude: what the call's result says. Codex details have none. */
  status?: ToolCallStatus
  /** Claude: the start of a failed call's error text. Never the output of a call that worked. */
  error?: string
}

/**
 * One entry of a session's recent messages. The text is conversation text: it may be shown in the
 * window only, and never logged, stored, or sent anywhere.
 */
export type SessionMessage =
  | { kind: 'prompt'; text: string; at: number; skill?: SkillMention }
  | { kind: 'reply'; text: string; at: number }
  // Calls hold bounded details on the detail path. Never output, except a failed call's error.
  | { kind: 'tool-calls'; count: number; names: string[]; at: number; calls?: ToolCallDetail[] }

/** Recent conversation text, returned only on request and never included in a snapshot. */
export type RecentMessages =
  | {
      kind: 'messages'
      messages: SessionMessage[]
      hasOlder: boolean
      /** Codex's latest terminal error, read only for the detail. Never in facts or snapshots. */
      error?: { cursor: string; message: string }
    }
  | { kind: 'not-found' }
  | { kind: 'unreadable' }
