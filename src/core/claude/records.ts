// Claude Code's files, turned into normalized data. Pure TypeScript: the file access lives in
// src/main/sessions/claude-source.ts.
//
// The formats are internal to Claude Code and undocumented. What is read here was observed on
// 2026-10-14 with Claude Code 2.1.284 to 2.1.295 in Claude.app; see the plan's "Local evidence" and
// the fixture in src/main/sessions/fixtures/claude-2.1.295. Unknown record types and fields are
// ignored, and a line that is not a JSON object with a `type` is skipped (CONSTRAINT-006).
//
// AgentPeek reads three kinds of files:
// - The Desktop catalog, one `local_<id>.json` per Claude.app session. Only the fields below are
//   picked; the file also holds permission and MCP settings, which are never kept.
// - The runtime registry, `~/.claude/sessions/<pid>.json`: one file per running Claude Code process.
// - The transcript, `~/.claude/projects/<folder>/<session id>.jsonl`: one record per line. AgentPeek
//   reads the prompts the user typed, the assistant's text and tool-call names, API errors, the
//   interrupt markers, and the session's custom title. Only when the detail asks for them, it also
//   reads each call's input and what its result says (see tool-details.ts). A tool's output is
//   never kept, except the start of a failed call's error.
// Text in transcript records is conversation data: show it in the window only, never log it.

import type { ToolCallDetail } from '../session'
import { claudeToolCall, errorExcerpt } from './tool-details'

/** What AgentPeek uses from a Desktop catalog file. */
export interface ClaudeCatalogEntry {
  /**
   * The CLI session ID: the registry's `sessionId` and the transcript's file name. The catalog
   * file's own name holds a different ID that only Claude.app uses (TASK-003).
   */
  cliSessionId: string
  /** The session's title in Claude.app, or null. */
  title: string | null
  cwd: string | null
  isArchived: boolean
  /** When Claude.app last saw activity in the session, in epoch milliseconds. */
  lastActivityAt: number | null
}

export type CatalogFileResult =
  | { kind: 'entry'; entry: ClaudeCatalogEntry }
  // JSON, but not a catalog entry AgentPeek understands.
  | { kind: 'unrecognized' }
  // Not JSON at all.
  | { kind: 'malformed' }

/** The registry's `status`, or `unrecognized` for a value AgentPeek does not know. */
export type ClaudeRegistryStatus = 'busy' | 'waiting' | 'idle' | 'unrecognized'

/** What AgentPeek uses from a registry file. */
export interface ClaudeRegistryEntry {
  pid: number
  sessionId: string
  cwd: string | null
  /** The session's name, which Claude Code keeps equal to the catalog title. */
  name: string | null
  /** Null while the process is starting: a new registry file has no status for a moment. */
  status: ClaudeRegistryStatus | null
  /** What the session waits for while `status` is `waiting`, such as `permission prompt`. */
  waitingFor: string | null
  /** When the file was last written, in epoch milliseconds. */
  updatedAt: number | null
  /** The process's start time as `ps -o lstart=` prints it in UTC, for the liveness check. */
  procStart: string | null
  /** The Claude Code version. */
  version: string | null
}

export type RegistryFileResult =
  | { kind: 'entry'; entry: ClaudeRegistryEntry }
  // JSON, but not a registry entry AgentPeek understands. The version is kept for the health line.
  | { kind: 'unrecognized'; version: string | null }
  // Not JSON. Claude Code rewrites registry files in place, so a read can catch one half-written.
  | { kind: 'malformed' }

/**
 * One transcript line, normalized. `at` is the record's `timestamp` in epoch milliseconds; records
 * without one (bookkeeping records such as `custom-title`) have null. `version` is the Claude Code
 * version that wrote the record, when it says.
 */
export type ClaudeRecord =
  // A prompt the user typed, or a slash command they ran. It starts a turn.
  | { kind: 'prompt'; at: number; version: string | null; text: string }
  // An assistant record: its text (empty when it has none) and the names of the tools it calls.
  // `endsTurn` is true for the turn's final reply (`stop_reason: end_turn`).
  | {
      kind: 'assistant'
      at: number
      version: string | null
      uuid: string | null
      text: string
      toolNames: string[]
      endsTurn: boolean
      /** Each call with its detail, only when the detail asked for tool details. */
      toolCalls?: ClaudeToolCall[]
    }
  // A record that returns tool results, read as such only when the detail asks for tool details.
  // Otherwise it is an `other` record.
  | { kind: 'tool-result'; at: number; version: string | null; results: ClaudeToolResult[] }
  // The turn stopped because of an API error. `errorCode` is Claude Code's `error`, such as
  // `rate_limit`.
  | {
      kind: 'api-error'
      at: number
      version: string | null
      uuid: string | null
      errorCode: string | null
    }
  // The user stopped the turn, or denied a permission (TASK-003). No reply and no error.
  | { kind: 'interrupt'; at: number; version: string | null }
  | { kind: 'custom-title'; at: number | null; version: string | null; title: string | null }
  // Any other record. It still counts as activity when it has a time.
  | { kind: 'other'; at: number | null; version: string | null }

/** A call in an assistant record. `id` matches its result's `tool_use_id`. */
export interface ClaudeToolCall {
  id: string | null
  detail: ToolCallDetail
}

/** What one `tool_result` part says about the call it answers. */
export interface ClaudeToolResult {
  id: string | null
  status: 'done' | 'failed' | 'interrupted'
  /** The start of the error text, for a failed call only. */
  error?: string
}

/** Options for `parseRecord`. */
export interface ParseOptions {
  /** Read each call's input and what its result says. Only the on-demand detail asks for this. */
  includeToolDetails?: boolean
}

/** Written when the user stops a turn. Matched exactly. */
export const STOP_MARKER = '[Request interrupted by user]'

/** Written when the user denies a tool permission, which also ends the turn. Matched exactly. */
export const DENIED_MARKER = '[Request interrupted by user for tool use]'

/**
 * The output of a slash command or a `!` shell command. Claude Code writes it as a user record,
 * without an `origin` in the files seen, but the user did not type it, so it is not a prompt. The
 * command itself (`<command-name>`, `<bash-input>`) is.
 */
const LOCAL_OUTPUT = /^\s*<(local-command-stdout|local-command-stderr|bash-stdout|bash-stderr)>/

type JsonObject = Record<string, unknown>

/** Reads a Desktop catalog file. Only the listed fields are picked from it. */
export function parseCatalogFile(text: string): CatalogFileResult {
  const value = parseJson(text)
  if (value === undefined) return { kind: 'malformed' }
  if (!isObject(value)) return { kind: 'unrecognized' }
  const cliSessionId = stringOrNull(value.cliSessionId)
  if (cliSessionId === null) return { kind: 'unrecognized' }
  return {
    kind: 'entry',
    entry: {
      cliSessionId,
      title: trimmedOrNull(value.title),
      cwd: stringOrNull(value.cwd),
      isArchived: value.isArchived === true,
      lastActivityAt: epochMsOrNull(value.lastActivityAt)
    }
  }
}

/** Reads a registry file. */
export function parseRegistryFile(text: string): RegistryFileResult {
  const value = parseJson(text)
  if (value === undefined) return { kind: 'malformed' }
  if (!isObject(value)) return { kind: 'unrecognized', version: null }
  const version = stringOrNull(value.version)
  const { pid } = value
  const sessionId = stringOrNull(value.sessionId)
  // A process ID of 0 or less would name a process group in the liveness check.
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0 || sessionId === null) {
    return { kind: 'unrecognized', version }
  }
  return {
    kind: 'entry',
    entry: {
      pid,
      sessionId,
      cwd: stringOrNull(value.cwd),
      name: trimmedOrNull(value.name),
      status: registryStatus(value.status),
      waitingFor: stringOrNull(value.waitingFor),
      updatedAt: epochMsOrNull(value.updatedAt),
      procStart: stringOrNull(value.procStart),
      version
    }
  }
}

/** Reads one transcript line. Returns null for a line that is not a JSON object with a `type`. */
export function parseRecord(line: string, options: ParseOptions = {}): ClaudeRecord | null {
  const value = parseJson(line)
  if (!isObject(value) || typeof value.type !== 'string') return null
  const at = timestampOrNull(value.timestamp)
  const version = stringOrNull(value.version)
  const details = options.includeToolDetails === true
  switch (value.type) {
    case 'user':
      return userRecord(value, at, version, details)
    case 'assistant':
      return assistantRecord(value, at, version, details)
    case 'custom-title':
      return { kind: 'custom-title', at, version, title: trimmedOrNull(value.customTitle) }
    default:
      return { kind: 'other', at, version }
  }
}

function registryStatus(status: unknown): ClaudeRegistryStatus | null {
  if (status === undefined || status === null) return null
  return status === 'busy' || status === 'waiting' || status === 'idle' ? status : 'unrecognized'
}

function userRecord(
  value: JsonObject,
  at: number | null,
  version: string | null,
  details: boolean
): ClaudeRecord {
  // Sidechains are subagent conversations; current versions keep them in separate files.
  if (at === null || value.isSidechain === true) return { kind: 'other', at, version }
  const content = isObject(value.message) ? value.message.content : undefined
  // A tool's result goes back to the model as a user record.
  if (hasPart(content, (type) => type === 'tool_result')) {
    return details
      ? { kind: 'tool-result', at, version, results: toolResults(value, content) }
      : { kind: 'other', at, version }
  }
  const text = joinText(content)
  if (text === STOP_MARKER || text === DENIED_MARKER) return { kind: 'interrupt', at, version }
  // Context Claude Code adds itself (`isMeta`), and the summary it writes after compacting.
  if (value.isMeta === true || value.isCompactSummary === true)
    return { kind: 'other', at, version }
  if (value.isVisibleInTranscriptOnly === true) return { kind: 'other', at, version }
  if (!fromUser(value.origin) || text.trim() === '') return { kind: 'other', at, version }
  if (LOCAL_OUTPUT.test(text)) return { kind: 'other', at, version }
  return { kind: 'prompt', at, version, text }
}

/**
 * Whether a user record came from the user. Newer records name their sender in `origin.kind`:
 * `human` for the user, `task-notification` for a background task that finished, and `peer` for
 * another session. Only the user's own messages start a turn the user has seen. Older records, and
 * a few current ones, have no `origin`.
 */
function fromUser(origin: unknown): boolean {
  return origin === undefined || (isObject(origin) && origin.kind === 'human')
}

/**
 * Each `tool_result` part: `is_error` marks a failed call, and a stopped command has
 * `toolUseResult.interrupted`. The output itself is only read for a failed call.
 */
function toolResults(value: JsonObject, content: unknown): ClaudeToolResult[] {
  const parts = Array.isArray(content)
    ? content.filter((part): part is JsonObject => isObject(part) && part.type === 'tool_result')
    : []
  // `toolUseResult` describes the record's result, so it is used only when there is one.
  const interrupted =
    parts.length === 1 && isObject(value.toolUseResult) && value.toolUseResult.interrupted === true
  return parts.map((part) => {
    const id = stringOrNull(part.tool_use_id)
    if (part.is_error !== true) return { id, status: interrupted ? 'interrupted' : 'done' }
    const text = joinText(part.content)
    if (interrupted || text === STOP_MARKER || text === DENIED_MARKER) {
      return { id, status: 'interrupted' }
    }
    return { id, status: 'failed', error: errorExcerpt(text) }
  })
}

function assistantRecord(
  value: JsonObject,
  at: number | null,
  version: string | null,
  details: boolean
): ClaudeRecord {
  if (at === null || value.isSidechain === true) return { kind: 'other', at, version }
  const uuid = stringOrNull(value.uuid)
  if (value.isApiErrorMessage === true) {
    return { kind: 'api-error', at, version, uuid, errorCode: stringOrNull(value.error) }
  }
  const message = isObject(value.message) ? value.message : {}
  const toolNames: string[] = []
  const toolCalls: ClaudeToolCall[] = []
  if (Array.isArray(message.content)) {
    for (const part of message.content) {
      // `tool_use`, and in case they appear, `server_tool_use` and other kinds of tool calls.
      if (isObject(part) && typeof part.type === 'string' && part.type.endsWith('tool_use')) {
        const name = stringOrNull(part.name) ?? part.type
        toolNames.push(name)
        if (details) {
          const cwd = stringOrNull(value.cwd)
          toolCalls.push({
            id: stringOrNull(part.id),
            detail: claudeToolCall(name, at, part.input, cwd)
          })
        }
      }
    }
  }
  return {
    kind: 'assistant',
    at,
    version,
    uuid,
    // Thinking is left out: AgentPeek does not show reasoning.
    text: joinText(message.content),
    toolNames,
    endsTurn: message.stop_reason === 'end_turn',
    ...(details ? { toolCalls } : {})
  }
}

function hasPart(content: unknown, test: (type: unknown) => boolean): boolean {
  return Array.isArray(content) && content.some((part) => isObject(part) && test(part.type))
}

/** A string's text, or the `text` of each text part joined by line breaks. Images are left out. */
function joinText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const part of content) {
    if (isObject(part) && part.type === 'text' && typeof part.text === 'string') {
      parts.push(part.text)
    }
  }
  return parts.join('\n')
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
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

/** A string without surrounding white space, or null when nothing is left. */
function trimmedOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/** Catalog and registry times are epoch milliseconds. */
function epochMsOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

/** Transcript times are ISO strings in UTC. */
function timestampOrNull(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const at = Date.parse(value)
  return Number.isNaN(at) ? null : at
}
