// Claude Code tool calls, turned into the detail's call entries. Pure TypeScript.
//
// A call is a `tool_use` part of an assistant record: `{ id, name, input }`, where `input` is an
// object whose fields depend on the tool. Observed on 2026-10-27: Bash `command`, `description`;
// Read `file_path`, `offset`, `limit`; Edit `file_path`, `old_string`, `new_string`,
// `replace_all`; Write `file_path`, `content`. Tools AgentPeek does not know get their input as
// JSON and a summary from the first familiar field. Each call becomes one line that says what it
// does (the summary) and a bounded input shown on demand.
//
// Everything here is conversation data: show it in the window only, never log or store it.

import type { ToolCallDetail } from '../session'
// The same bounds as Codex details.
import { TOOL_INPUT_LIMIT } from '../codex/tool-details'

/** The longest summary line, in characters. */
export const SUMMARY_LIMIT = 200

/** The most of a failed call's error text that is kept, in characters. */
export const ERROR_LIMIT = 300

/** Fields that name what a call works on, in the order a summary picks them for other tools. */
const SUMMARY_FIELDS = [
  'description',
  'query',
  'url',
  'pattern',
  'file_path',
  'path',
  'notebook_path',
  'command',
  'skill',
  'prompt',
  'title',
  'name'
]
const PATH_FIELDS = new Set(['file_path', 'path', 'notebook_path'])

type JsonObject = Record<string, unknown>

/**
 * One call as the detail shows it. `cwd` is the record's working folder: paths inside it are
 * shown relative to it. The result's status is added later, when the result is matched.
 */
export function claudeToolCall(
  name: string,
  at: number,
  input: unknown,
  cwd: string | null
): ToolCallDetail {
  const fields = isObject(input) ? input : null
  const shown = fields === null ? null : shownInput(name, fields)
  return {
    name: shortToolName(name),
    at,
    input: shown === null ? null : shown.text.slice(0, TOOL_INPUT_LIMIT),
    inputLength: shown?.text.length ?? 0,
    nestedNames: null,
    summary: fields === null ? null : summaryLine(name, fields, cwd),
    ...(shown?.format ? { inputFormat: shown.format } : {})
  }
}

/**
 * MCP tools are named `mcp__<server>__<tool>`. The detail shows the tool, followed by the server
 * unless the server is an ID, as for connectors Claude.app adds.
 */
export function shortToolName(name: string): string {
  const [, server, tool] = /^mcp__(.+?)__(.+)$/.exec(name) ?? []
  if (server === undefined || tool === undefined) return name
  return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(server) ? tool : `${tool} (${server})`
}

/**
 * The start of a failed call's error text, without the `<tool_use_error>` wrapper Claude Code
 * puts around some errors.
 */
export function errorExcerpt(text: string): string {
  const unwrapped = text
    .trim()
    .replace(/^<tool_use_error>([\s\S]*)<\/tool_use_error>$/, '$1')
    .trim()
  return unwrapped.length > ERROR_LIMIT ? `${unwrapped.slice(0, ERROR_LIMIT)}…` : unwrapped
}

/** The input as the detail shows it: the field that matters for known tools, JSON otherwise. */
function shownInput(name: string, input: JsonObject): { text: string; format?: 'diff' } {
  const { command, content, prompt, old_string: before, new_string: after } = input
  if (name === 'Bash' && typeof command === 'string') return { text: command }
  if (name === 'Write' && typeof content === 'string') return { text: content }
  if ((name === 'Agent' || name === 'Task') && typeof prompt === 'string') return { text: prompt }
  if (name === 'Edit' && typeof before === 'string' && typeof after === 'string') {
    const lines = [...prefixed('-', before), ...prefixed('+', after)]
    return { text: lines.join('\n'), format: 'diff' }
  }
  return { text: Object.keys(input).length === 0 ? '' : JSON.stringify(input, null, 2) }
}

function prefixed(sign: string, text: string): string[] {
  return text === '' ? [] : text.split('\n').map((line) => sign + line)
}

/** One line that says what the call does, or null when its input names nothing familiar. */
function summaryLine(name: string, input: JsonObject, cwd: string | null): string | null {
  const text = (key: string) => {
    const value = input[key]
    if (typeof value !== 'string' || value.trim() === '') return null
    return PATH_FIELDS.has(key) ? relativePath(value, cwd) : value
  }
  const path = text('file_path') ?? text('notebook_path')
  let line: string | null
  switch (name) {
    case 'Bash':
      line = text('description') ?? text('command')
      break
    case 'Read':
      line = path === null ? null : [path, readRange(input)].filter(Boolean).join(' · ')
      break
    case 'Edit': {
      const { old_string: before, new_string: after } = input
      line =
        path === null || typeof before !== 'string' || typeof after !== 'string'
          ? path
          : `${path} · −${lineCount(before)} +${lineCount(after)} lines` +
            (input.replace_all === true ? ' · all matches' : '')
      break
    }
    case 'Write':
      line =
        path === null || typeof input.content !== 'string'
          ? path
          : `${path} · ${lineCount(input.content)} lines`
      break
    case 'Grep':
    case 'Glob': {
      const pattern = text('pattern')
      const folder = text('path')
      line = pattern === null ? folder : folder === null ? pattern : `${pattern} in ${folder}`
      break
    }
    case 'TodoWrite':
      line = Array.isArray(input.todos) ? `${input.todos.length} to-dos` : null
      break
    case 'AskUserQuestion': {
      const first: unknown = Array.isArray(input.questions) ? input.questions[0] : undefined
      line = isObject(first) && typeof first.question === 'string' ? first.question : null
      break
    }
    default:
      line = SUMMARY_FIELDS.reduce<string | null>((found, key) => found ?? text(key), null)
  }
  return line === null ? null : oneLine(line)
}

/** Read's `offset` is the first line to read and `limit` the number of lines. */
function readRange(input: JsonObject): string | null {
  const { offset, limit, pages } = input
  if (typeof pages === 'string' && pages !== '') return `pages ${pages}`
  const start = typeof offset === 'number' && offset > 0 ? offset : 1
  if (typeof limit === 'number' && limit > 0) return `lines ${start}–${start + limit - 1}`
  return typeof offset === 'number' && offset > 0 ? `from line ${start}` : null
}

function lineCount(text: string): number {
  if (text === '') return 0
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
}

function relativePath(path: string, cwd: string | null): string {
  if (cwd === null || cwd === '') return path
  const folder = cwd.endsWith('/') ? cwd : `${cwd}/`
  return path.startsWith(folder) && path.length > folder.length ? path.slice(folder.length) : path
}

/** The first line with text, its white space collapsed, at most `SUMMARY_LIMIT` characters. */
export function oneLine(text: string): string | null {
  const line = text
    .split('\n')
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .find((part) => part !== '')
  if (line === undefined) return null
  return line.length > SUMMARY_LIMIT ? `${line.slice(0, SUMMARY_LIMIT)}…` : line
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
