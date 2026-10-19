// Codex rollout and index lines, turned into normalized records. Pure TypeScript: the file access
// lives in src/main/sessions/codex-source.ts.
//
// The formats are internal to Codex and undocumented. What is read here was observed on 2026-10-14
// in ChatGPT.app 26.1007 (rollout `cli_version` 0.162.0-alpha.17.2); see the plan's "Local
// evidence" (re-check on 2026-10-14) and the fixture in src/main/sessions/fixtures/codex-0.162.
// Unknown record types and fields are ignored, and a line that is not JSON or lacks the record
// envelope is skipped (CONSTRAINT-006).
//
// Every rollout line is `{ timestamp, type, payload }`. AgentPeek reads:
// - the first line, `session_meta`: the thread ID, folder, version, and whether a user started it;
// - the turn events `task_started`, `task_complete`, and `turn_aborted` (`event_msg`);
// - `item_completed` events with a `UserMessage` or `AgentMessage` item: prompts and replies as the
//   Codex app shows them. The `response_item` messages are not used for text, because Codex also
//   puts context it adds itself there (the environment, AGENTS.md) as user messages;
// - the names of tool calls (`response_item` types ending in `_call`), never their input or output.
// Text in these records is conversation data: show it in the window only, never log it.

/** What a rollout's first line says about its thread. */
export interface CodexThreadMeta {
  /** The thread ID. The Codex app, its index, and the rollout's file name use the same ID. */
  id: string
  /**
   * True for a thread the user started (REQ-002): `source` is a string, `thread_source` is `user`,
   * and there is no `parent_thread_id`. Review, subagent, and automation threads are false.
   */
  isUserThread: boolean
  /** The thread's working folder. */
  cwd: string | null
  /** The `cli_version` that wrote the rollout. */
  cliVersion: string | null
}

export type SessionMetaResult =
  | { kind: 'meta'; meta: CodexThreadMeta }
  // Not a `session_meta` line AgentPeek understands. The version is kept for the health line.
  | { kind: 'unrecognized'; cliVersion: string | null }

/** How a turn ended, when it ended with a final reply or an error. */
export interface CodexTurnOutcome {
  /** The turn's `turn_id`, used as the read cursor. */
  turnId: string
  isError: boolean
  /** For an error, Codex's `codex_error_info`, such as `server_overloaded`. */
  errorCode: string | null
}

/** One rollout line, normalized. `at` is the line's `timestamp` in epoch milliseconds. */
export type CodexRecord =
  | { kind: 'turn-started'; at: number }
  // `outcome` is null when the turn ended without a final reply or an error.
  | { kind: 'turn-completed'; at: number; outcome: CodexTurnOutcome | null; errorMessage?: string }
  | { kind: 'turn-aborted'; at: number }
  | { kind: 'user-message'; at: number; text: string }
  | { kind: 'agent-message'; at: number; text: string }
  | { kind: 'tool-call'; at: number; name: string }
  // Any other line with the record envelope. It still counts as activity.
  | { kind: 'other'; at: number }

/** One line of `session_index.jsonl`. The last line for an ID wins. */
export interface CodexIndexEntry {
  id: string
  /** The thread's name, or null when it has none. */
  title: string | null
}

type JsonObject = Record<string, unknown>

/** Reads a rollout's first line. */
export function parseSessionMeta(line: string): SessionMetaResult {
  const value = parseJson(line)
  const payload = isObject(value) && isObject(value.payload) ? value.payload : null
  const cliVersion = stringOrNull(payload?.cli_version)
  if (!isObject(value) || value.type !== 'session_meta' || payload === null) {
    return { kind: 'unrecognized', cliVersion }
  }
  const id = stringOrNull(payload.id)
  if (id === null) return { kind: 'unrecognized', cliVersion }
  const isUserThread =
    typeof payload.source === 'string' &&
    payload.thread_source === 'user' &&
    (payload.parent_thread_id === undefined || payload.parent_thread_id === null)
  return { kind: 'meta', meta: { id, isUserThread, cwd: stringOrNull(payload.cwd), cliVersion } }
}

/** Reads one rollout line. Returns null for a line that is not JSON or lacks the envelope. */
export function parseRecord(line: string): CodexRecord | null {
  const value = parseJson(line)
  if (!isObject(value) || typeof value.type !== 'string' || typeof value.timestamp !== 'string') {
    return null
  }
  const at = Date.parse(value.timestamp)
  if (Number.isNaN(at)) return null
  const payload = isObject(value.payload) ? value.payload : {}
  if (value.type === 'event_msg') return eventRecord(payload, at)
  if (value.type === 'response_item') return responseItemRecord(payload, at)
  return { kind: 'other', at }
}

/** Reads one line of `session_index.jsonl`. Returns null for a line it cannot use. */
export function parseIndexLine(line: string): CodexIndexEntry | null {
  const value = parseJson(line)
  if (!isObject(value)) return null
  const id = stringOrNull(value.id)
  if (id === null) return null
  const title = typeof value.thread_name === 'string' ? value.thread_name.trim() : ''
  return { id, title: title === '' ? null : title }
}

function eventRecord(payload: JsonObject, at: number): CodexRecord {
  switch (payload.type) {
    case 'task_started':
      return { kind: 'turn-started', at }
    case 'task_complete':
      return {
        kind: 'turn-completed',
        at,
        outcome: turnOutcome(payload),
        ...(isObject(payload.error) && typeof payload.error.message === 'string'
          ? { errorMessage: payload.error.message }
          : {})
      }
    case 'turn_aborted':
      // A turn the user stopped: no reply and no error (TASK-003).
      return { kind: 'turn-aborted', at }
    case 'item_completed':
      return itemRecord(payload.item, at)
    default:
      return { kind: 'other', at }
  }
}

function turnOutcome(payload: JsonObject): CodexTurnOutcome | null {
  const turnId = stringOrNull(payload.turn_id)
  if (turnId === null) return null
  // Without an error the key is absent; TASK-003 also saw `null`.
  if (payload.error !== undefined && payload.error !== null) {
    return { turnId, isError: true, errorCode: errorCode(payload.error) }
  }
  if (stringOrNull(payload.last_agent_message) !== null) {
    return { turnId, isError: false, errorCode: null }
  }
  return null
}

function errorCode(error: unknown): string | null {
  if (!isObject(error)) return null
  const info = error.codex_error_info
  if (typeof info === 'string') return info === '' ? null : info
  // In Codex's source, error kinds that carry details are written as an object with one key, such
  // as `{ "http_connection_failed": { … } }`. Not observed yet.
  if (isObject(info)) return Object.keys(info)[0] ?? null
  return null
}

function itemRecord(item: unknown, at: number): CodexRecord {
  if (isObject(item)) {
    if (item.type === 'UserMessage') {
      // Its content also holds attached images (`local_image`), which are left out.
      const text = joinText(item.content)
      if (text !== '') return { kind: 'user-message', at, text }
    } else if (item.type === 'AgentMessage') {
      // Both the progress notes (`phase: commentary`) and the final answer (`final_answer`).
      const text = joinText(item.content)
      if (text !== '') return { kind: 'agent-message', at, text }
    }
  }
  return { kind: 'other', at }
}

function responseItemRecord(payload: JsonObject, at: number): CodexRecord {
  const { type } = payload
  // `function_call` and `custom_tool_call` carry a name. Other calls, such as a web search, are
  // named after their type.
  if (typeof type === 'string' && type.endsWith('_call')) {
    const name = stringOrNull(payload.name) ?? type.slice(0, -'_call'.length)
    return { kind: 'tool-call', at, name }
  }
  return { kind: 'other', at }
}

/** Joins the `text` of each content part that has one. */
function joinText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const part of content) {
    if (isObject(part) && typeof part.text === 'string') parts.push(part.text)
  }
  return parts.join('\n')
}

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A non-empty string, or null. */
function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}
