// Antigravity Desktop tool calls, turned into the detail's call entries. Pure TypeScript.
//
// A call is one entry of a `PLANNER_RESPONSE` step's `tool_calls`: `{ name, args }`, with no call
// ID. Observed on 2026-11-25 across Antigravity Desktop transcripts: `args` is an object whose
// values are all strings, and most tools carry `toolSummary`, a one-line description Antigravity
// writes for the call, and `toolAction`, a short label. Fields by tool, as observed:
// - `read_file` `Path`, `StartLine`, `EndLine`; older `view_file` `AbsolutePath`;
// - `run_command` `CommandLine`, `Cwd`;
// - `edit_file` `Path`, `Target`, `Replacement`; older `replace_file_content` `TargetFile`,
//   `TargetContent`, `ReplacementContent`;
// - `write_file` `Path`, `Content`; older `write_to_file` `TargetFile`, `CodeContent`;
// - `call_mcp_tool` `ServerName`, `ToolName`, `Arguments` (a JSON string).
// Each call becomes one line that says what it does (the summary) and a bounded input shown on
// demand. Its result is matched later, by step index (see messages.ts).
//
// Everything here is conversation data: show it in the window only, never log or store it.

import type { ToolCallDetail } from '../session'
// The same bounds as Codex and Claude Code details.
import { TOOL_INPUT_LIMIT } from '../codex/tool-details'
import { oneLine } from '../claude/tool-details'

type JsonObject = Record<string, unknown>

/** Fields Antigravity adds to describe a call, never part of the input the detail shows. */
const DESCRIPTION_FIELDS = new Set(['toolSummary', 'toolAction'])

/** Fields that name what a call works on, in the order a summary picks them without a summary. */
const SUMMARY_FIELDS = [
  'Path',
  'AbsolutePath',
  'TargetFile',
  'DirectoryPath',
  'SearchPath',
  'SearchDirectory',
  'CommandLine',
  'Query',
  'query',
  'Pattern',
  'Url',
  'Description',
  'Prompt',
  'Message',
  'Action'
]

/** One call as the detail shows it. The result's status is added later. */
export function antigravityToolCall(name: string, at: number, args: unknown): ToolCallDetail {
  const fields = isObject(args) ? args : null
  const shown = fields === null ? null : shownInput(name, fields)
  return {
    name,
    at,
    input: shown === null ? null : shown.text.slice(0, TOOL_INPUT_LIMIT),
    inputLength: shown?.text.length ?? 0,
    nestedNames: null,
    summary: fields === null ? null : summaryLine(fields),
    ...(shown?.format ? { inputFormat: shown.format } : {})
  }
}

/** The input as the detail shows it: the field that matters for known tools, JSON otherwise. */
function shownInput(name: string, args: JsonObject): { text: string; format?: 'diff' } {
  const text = (key: string): string | null => {
    const value = args[key]
    return typeof value === 'string' ? value : null
  }
  const command = text('CommandLine')
  if (name === 'run_command' && command !== null) return { text: command }
  const content = text('Content') ?? text('CodeContent')
  if ((name === 'write_file' || name === 'write_to_file') && content !== null) {
    return { text: content }
  }
  const before = text('Target') ?? text('TargetContent')
  const after = text('Replacement') ?? text('ReplacementContent')
  if (
    (name === 'edit_file' || name === 'replace_file_content') &&
    before !== null &&
    after !== null
  ) {
    return { text: [...prefixed('-', before), ...prefixed('+', after)].join('\n'), format: 'diff' }
  }
  const input = Object.fromEntries(
    Object.entries(args).filter(([key]) => !DESCRIPTION_FIELDS.has(key))
  )
  return { text: Object.keys(input).length === 0 ? '' : JSON.stringify(input, null, 2) }
}

/** Antigravity's own summary, or one built from the first familiar field. */
function summaryLine(args: JsonObject): string | null {
  const text = (key: string) => {
    const value = args[key]
    return typeof value === 'string' && value.trim() !== '' ? value : null
  }
  const own = text('toolSummary')
  if (own !== null) return oneLine(own)
  const tool = text('ToolName')
  if (tool !== null) {
    const server = text('ServerName')
    return oneLine(server === null ? tool : `${tool} (${server})`)
  }
  const field = SUMMARY_FIELDS.find((key) => text(key) !== null)
  if (field === undefined) return null
  const start = text('StartLine')
  const end = text('EndLine')
  const range =
    start !== null && end !== null
      ? `lines ${start}–${end}`
      : start !== null
        ? `from line ${start}`
        : end !== null
          ? `to line ${end}`
          : null
  return oneLine([text(field), range].filter(Boolean).join(' · '))
}

function prefixed(sign: string, text: string): string[] {
  return text === '' ? [] : text.split('\n').map((line) => sign + line)
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
