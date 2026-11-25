// Antigravity Desktop transcript lines and title files, turned into normalized records. Pure
// TypeScript: the file access lives in src/main/sessions/antigravity-source.ts.
//
// The formats are internal to Antigravity and undocumented beyond the transcript's path. What is
// read here was observed on 2026-11-23 in Antigravity Desktop 2.34.0 (`com.google.antigravity`);
// see the Antigravity plan's TASK-001 probe. Every `transcript.jsonl` line is one completed step:
// `{ step_index, created_at, type, source, status, content?, tool_calls?, truncated_fields? }`.
// AgentPeek reads:
// - `USER_INPUT` from `USER_EXPLICIT`: a user prompt, wrapped in `<USER_REQUEST>`. A `/name` skill
//   request adds one `<SKILL>` block to its `<ADDITIONAL_METADATA>`, naming the skill and the path
//   of its SKILL.md, never its text (observed 2026-11-25);
// - `SYSTEM_MESSAGE` from `SYSTEM`: the first step of a subagent transcript, which is never listed;
// - `PLANNER_RESPONSE`: with `tool_calls`, a step that asks for tools (its `content` is commentary,
//   never a final reply); without them, the turn's final reply;
// - `GENERIC`: a tool result. `ERROR` there fails one step, not the turn. Its output is never read.
//   Older versions write typed result steps instead (`VIEW_FILE`, `RUN_COMMAND`, `MCP_TOOL`, …), or
//   `ERROR_MESSAGE` for a call that failed. The result of a step's k-th call is the step at
//   `step_index + 1 + k` (observed 2026-11-25: every typed result matched its call's tool).
// A line that is not JSON or lacks `step_index`, `type`, or `created_at` is skipped.
// The file mtime supplies the time for an unfamiliar timestamp encoding.
// `thinking` is never read. Tool arguments, a failed result's `error`, and the skill block are read
// only with the text, on the detail path.
// Text in these records is conversation data: show it in the window only, never log it.

import { isSkillName, isSkillPath } from '../skill-names'
import type { ToolCallDetail } from '../session'
import { antigravityToolCall } from './tool-details'

/** A step's `status`, normalized. */
export type AntigravityStepStatus = 'done' | 'error' | 'canceled' | 'other'

interface StepBase {
  /** `step_index`: the step's position in the conversation, counting from 0. */
  step: number
  /** `created_at` in epoch milliseconds. */
  at: number
  /** `created_at` as written, or null when its encoding is unknown. */
  stamp: string | null
  status: AntigravityStepStatus
}

/**
 * One transcript line, normalized. Text is present only when the reader asked for it (the detail's
 * recent messages); the catalog reads records without text.
 */
export type AntigravityRecord =
  | (StepBase & {
      kind: 'user-input'
      text?: string
      truncated: boolean
      /** The skill a `/name` request asked for (detail path only). */
      skill?: { name: string; path: string }
    })
  | (StepBase & { kind: 'system-message' })
  | (StepBase & {
      kind: 'planner-response'
      /** Whether `content` holds text. */
      hasContent: boolean
      text?: string
      truncated: boolean
      /**
       * The names of the tools the step asked for, or null when it asked for none. An empty array
       * means it asked for tools whose names were cut (`truncated_fields` has `tool_calls`).
       */
      toolCalls: string[] | null
      /** How many tools the step asked for: at least 1 when `toolCalls` is not null. */
      toolCallCount: number
      /** Each named call, in order, with its bounded input (detail path only). */
      calls?: ToolCallDetail[]
    })
  | (StepBase & { kind: 'tool-result'; error?: string })
  | (StepBase & {
      kind: 'other'
      /** A typed result step of an older version, or `ERROR_MESSAGE` (detail path only). */
      toolStep?: true
      /** `ERROR_MESSAGE`: written `DONE`, yet in a call's place it means the call failed. */
      failedCall?: true
      error?: string
    })

type JsonObject = Record<string, unknown>

/** Reads one transcript line. Returns null for a line that is not JSON or lacks the step fields. */
export function parseRecord(
  line: string,
  options: { includeText?: boolean; fallbackAt?: number } = {}
): AntigravityRecord | null {
  const value = parseJson(line)
  if (!isObject(value) || typeof value.type !== 'string') return null
  const step = value.step_index
  if (typeof step !== 'number' || !Number.isSafeInteger(step) || step < 0) return null
  const encodedTime = value.created_at
  const time =
    parseTime(encodedTime) ??
    (encodedTime != null && options.fallbackAt !== undefined
      ? { at: options.fallbackAt, stamp: null }
      : null)
  if (time === null) return null
  const base: StepBase = { step, at: time.at, stamp: time.stamp, status: parseStatus(value.status) }
  const includeText = options.includeText === true
  const truncated = truncatedFields(value)
  const finishedStep = base.status === 'done' || base.status === 'canceled'

  if (value.type === 'USER_INPUT' && value.source === 'USER_EXPLICIT' && finishedStep) {
    const content = typeof value.content === 'string' ? value.content : ''
    const skill = includeText ? requestedSkill(content) : null
    return {
      ...base,
      kind: 'user-input',
      truncated: truncated.has('content'),
      ...(includeText ? { text: userRequestText(content) } : {}),
      ...(skill !== null ? { skill } : {})
    }
  }
  if (value.type === 'SYSTEM_MESSAGE' && value.source === 'SYSTEM') {
    return { ...base, kind: 'system-message' }
  }
  if (value.type === 'PLANNER_RESPONSE' && value.source === 'MODEL' && finishedStep) {
    const truncatedCalls = truncated.has('tool_calls')
    if (
      base.status === 'done' &&
      !truncatedCalls &&
      value.tool_calls !== undefined &&
      !Array.isArray(value.tool_calls)
    ) {
      return { ...base, kind: 'other' }
    }
    const content = typeof value.content === 'string' ? value.content.trim() : ''
    return {
      ...base,
      kind: 'planner-response',
      hasContent: content !== '',
      truncated: truncated.has('content'),
      ...toolCalls(value.tool_calls, truncatedCalls),
      ...(includeText ? { text: content, ...callDetails(value.tool_calls, base.at) } : {})
    }
  }
  const error =
    includeText && base.status === 'error' && typeof value.error === 'string' ? value.error : null
  if (value.type === 'GENERIC' && value.source === 'MODEL' && base.status !== 'other') {
    return { ...base, kind: 'tool-result', ...(error !== null ? { error } : {}) }
  }
  const toolStep =
    includeText &&
    !TURN_STEP_TYPES.has(value.type) &&
    (value.source === 'MODEL' || value.type === 'ERROR_MESSAGE')
  return {
    ...base,
    kind: 'other',
    ...(toolStep ? { toolStep: true as const } : {}),
    ...(toolStep && value.type === 'ERROR_MESSAGE' ? { failedCall: true as const } : {}),
    ...(toolStep && typeof value.error === 'string' ? { error: value.error } : {})
  }
}

/** Steps that are never a tool's result, even in a call's place. */
const TURN_STEP_TYPES = new Set(['PLANNER_RESPONSE', 'USER_INPUT', 'SYSTEM_MESSAGE'])

/** Each named call with its bounded input. A cut `tool_calls` gives the calls that are left. */
function callDetails(value: unknown, at: number): { calls?: ToolCallDetail[] } {
  if (!Array.isArray(value) || value.length === 0) return {}
  const calls: ToolCallDetail[] = []
  for (const call of value) {
    const name = isObject(call) && typeof call.name === 'string' ? call.name.trim() : ''
    if (name !== '') calls.push(antigravityToolCall(name, at, (call as JsonObject).args))
  }
  return calls.length > 0 ? { calls } : {}
}

/** The exact block Antigravity adds for a `/name` request (observed 2026-11-25). */
const SKILL_BLOCK =
  /^The user requested you read and use the "([^"\r\n]+)" skill\. The path to the skill file is:\r?\n([^\r\n]+)$/

/**
 * The skill named by the one `<SKILL>` block in a prompt's own metadata, after the user's request.
 * A block inside the request is the user's text, and two blocks name no single skill.
 */
export function requestedSkill(content: string): { name: string; path: string } | null {
  const open = '<USER_REQUEST>'
  const start = content.indexOf(open)
  if (start === -1) return null
  USER_REQUEST_END.lastIndex = start + open.length
  const end = USER_REQUEST_END.exec(content)?.index
  if (end === undefined) return null
  const blocks = [...content.slice(end).matchAll(/<SKILL>([\s\S]*?)<\/SKILL>/g)]
  if (blocks.length !== 1) return null
  const match = SKILL_BLOCK.exec(blocks[0]![1]!.trim())
  const name = match?.[1]
  const path = match?.[2]
  return isSkillName(name) && isSkillPath(path) ? { name, path } : null
}

/** Whether a record is a turn's final reply: a finished answer that asks for no tools. */
export function isFinalReply(record: AntigravityRecord): boolean {
  return (
    record.kind === 'planner-response' &&
    record.status === 'done' &&
    record.hasContent &&
    record.toolCalls === null
  )
}

/** The reply cursor: independent of file metadata, including when display time uses the mtime. */
export function replyCursor(record: AntigravityRecord): string {
  return `${record.step}:${record.stamp ?? 'unknown-time'}`
}

/**
 * Where a prompt's `<USER_REQUEST>` really ends: at a closing tag followed only by whitespace and
 * then Antigravity's own context (`<ADDITIONAL_METADATA>`, `<USER_SETTINGS_CHANGE>`), a tag that
 * truncation cut short, or the end. A closing tag in the user's own text is followed by more of it,
 * and one quoted inside the metadata comes after the real end.
 */
const USER_REQUEST_END =
  /<\/USER_REQUEST>(?=\s*(?:<ADDITIONAL_METADATA>|<USER_SETTINGS_CHANGE>|<[A-Z_]*$|$))/g

/**
 * The user's own words in a prompt. Antigravity wraps them in `<USER_REQUEST>` and adds context of
 * its own (`<ADDITIONAL_METADATA>`, `<USER_SETTINGS_CHANGE>`), which is left out. A prompt cut short
 * by truncation may lack the closing tag.
 */
export function userRequestText(content: string): string {
  const open = '<USER_REQUEST>'
  const start = content.indexOf(open)
  if (start !== -1) {
    const from = start + open.length
    USER_REQUEST_END.lastIndex = from
    const end = USER_REQUEST_END.exec(content)?.index
    return (end === undefined ? content.slice(from) : content.slice(from, end)).trim()
  }
  return content
    .replace(/<(ADDITIONAL_METADATA|USER_SETTINGS_CHANGE)>[\s\S]*?(?:<\/\1>|$)/g, '')
    .trim()
}

function toolCalls(
  value: unknown,
  truncated: boolean
): { toolCalls: string[] | null; toolCallCount: number } {
  if (Array.isArray(value) && value.length > 0) {
    const names: string[] = []
    for (const call of value) {
      const name = isObject(call) && typeof call.name === 'string' ? call.name.trim() : ''
      if (name !== '' && !names.includes(name)) names.push(name)
    }
    return { toolCalls: names, toolCallCount: value.length }
  }
  // A cut `tool_calls` may be omitted, null, empty, or no longer an array; the step still asked
  // for tools.
  return truncated ? { toolCalls: [], toolCallCount: 1 } : { toolCalls: null, toolCallCount: 0 }
}

function truncatedFields(value: JsonObject): Set<string> {
  const fields = Array.isArray(value.truncated_fields) ? value.truncated_fields : []
  return new Set(fields.filter((field): field is string => typeof field === 'string'))
}

function parseStatus(value: unknown): AntigravityStepStatus {
  switch (value) {
    case 'DONE':
      return 'done'
    case 'ERROR':
      return 'error'
    case 'CANCELED':
    case 'CANCELLED':
      return 'canceled'
    default:
      return 'other'
  }
}

/** Epoch seconds below this are read as seconds, larger values as milliseconds (year 5138). */
const SECONDS_LIMIT = 100_000_000_000

/**
 * Reads `created_at`. The probe did not record its encoding, so an ISO 8601 string, epoch seconds or
 * milliseconds, and a protobuf `{ seconds, nanos }` object are all accepted.
 */
function parseTime(value: unknown): { at: number; stamp: string } | null {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    const at = Date.parse(value)
    return Number.isNaN(at) ? null : { at, stamp: value }
  }
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return { at: value < SECONDS_LIMIT ? value * 1000 : value, stamp: String(value) }
  }
  if (isObject(value)) {
    const seconds = parseNumeric(value.seconds)
    const nanos = value.nanos === undefined ? 0 : parseNumeric(value.nanos)
    if (
      seconds !== null &&
      seconds > 0 &&
      Number.isFinite(seconds * 1000) &&
      nanos !== null &&
      nanos >= 0 &&
      nanos < 1_000_000_000
    ) {
      return { at: seconds * 1000 + Math.floor(nanos / 1_000_000), stamp: `${seconds}.${nanos}` }
    }
  }
  return null
}

function parseNumeric(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/**
 * The `title` of an annotation file (`annotations/<id>.pbtxt`), a protobuf text-format message.
 * Only a top-level `title` string is read; every other field is skipped. Returns null when there is
 * none, it is blank, or the file cannot be read as text format.
 */
export function parseAnnotationTitle(text: string): string | null {
  let depth = 0
  let index = 0
  while (index < text.length) {
    const char = text[index] ?? ''
    if (char === '#') {
      const end = text.indexOf('\n', index)
      index = end === -1 ? text.length : end + 1
    } else if (char === '"' || char === "'") {
      const string = readString(text, index)
      if (string === null) return null
      index = string.end
    } else if (char === '{' || char === '<') {
      depth++
      index++
    } else if (char === '}' || char === '>') {
      depth = Math.max(0, depth - 1)
      index++
    } else if (/[A-Za-z_]/.test(char)) {
      const match = /^[A-Za-z0-9_]+/.exec(text.slice(index))
      const name = match?.[0] ?? char
      index += name.length
      if (depth !== 0 || name !== 'title') continue
      const title = readTitleValue(text, index)
      if (title !== undefined) return title
    } else {
      index++
    }
  }
  return null
}

/** The string value after a `title` name, or undefined when the field is not a string. */
function readTitleValue(text: string, start: number): string | null | undefined {
  let index = skipSpace(text, start)
  if (text[index] === ':') index = skipSpace(text, index + 1)
  const parts: number[] = []
  let found = false
  // Text format joins adjacent strings: `title: "a" "b"`.
  while (text[index] === '"' || text[index] === "'") {
    const string = readString(text, index)
    if (string === null) return null
    parts.push(...string.bytes)
    found = true
    index = skipSpace(text, string.end)
  }
  if (!found) return undefined
  const title = new TextDecoder('utf-8').decode(new Uint8Array(parts)).replace(/\s+/g, ' ').trim()
  return title === '' ? null : title
}

function skipSpace(text: string, start: number): number {
  let index = start
  while (index < text.length && /\s/.test(text[index] ?? '')) index++
  return index
}

const SIMPLE_ESCAPES: Record<string, number> = {
  n: 0x0a,
  t: 0x09,
  r: 0x0d,
  a: 0x07,
  b: 0x08,
  f: 0x0c,
  v: 0x0b,
  '\\': 0x5c,
  "'": 0x27,
  '"': 0x22,
  '?': 0x3f
}

/**
 * Reads a quoted text-format string starting at `start`, as UTF-8 bytes (octal and `\x` escapes
 * name bytes). Returns null for a string that does not end on its line.
 */
function readString(text: string, start: number): { bytes: number[]; end: number } | null {
  const quote = text[start]
  const encoder = new TextEncoder()
  const bytes: number[] = []
  let index = start + 1
  while (index < text.length) {
    const char = text[index] ?? ''
    if (char === quote) return { bytes, end: index + 1 }
    if (char === '\n') return null
    if (char !== '\\') {
      const codePoint = text.codePointAt(index) ?? 0
      const whole = String.fromCodePoint(codePoint)
      bytes.push(...encoder.encode(whole))
      index += whole.length
      continue
    }
    const next = text[index + 1] ?? ''
    const simple = SIMPLE_ESCAPES[next]
    if (simple !== undefined) {
      bytes.push(simple)
      index += 2
      continue
    }
    const octal = /^[0-7]{1,3}/.exec(text.slice(index + 1, index + 4))
    if (octal !== null) {
      bytes.push(parseInt(octal[0], 8) & 0xff)
      index += 1 + octal[0].length
      continue
    }
    const hex = next === 'x' ? /^[0-9A-Fa-f]{1,2}/.exec(text.slice(index + 2, index + 4)) : null
    if (hex !== null) {
      bytes.push(parseInt(hex[0], 16))
      index += 2 + hex[0].length
      continue
    }
    const unicode =
      next === 'u'
        ? /^[0-9A-Fa-f]{4}/.exec(text.slice(index + 2, index + 6))
        : next === 'U'
          ? /^[0-9A-Fa-f]{8}/.exec(text.slice(index + 2, index + 10))
          : null
    const codePoint = unicode === null ? NaN : parseInt(unicode[0], 16)
    if (unicode !== null && codePoint <= 0x10ffff) {
      bytes.push(...encoder.encode(String.fromCodePoint(codePoint)))
      index += 2 + unicode[0].length
      continue
    }
    // An unknown escape: keep the character after the backslash.
    bytes.push(...encoder.encode(next))
    index += 2
  }
  return null
}

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
