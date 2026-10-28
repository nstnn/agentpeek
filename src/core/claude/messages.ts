import type { SessionMessage, ToolCallDetail } from '../session'
import { TOOL_GROUP_LIMIT } from '../codex/tool-details'
import type { ClaudeRecord, ClaudeToolCall, ClaudeToolResult } from './records'
import { shortToolName } from './tool-details'
import { marksTurn } from './transcript-state'
import { claudeCommand, claudePromptSkill } from './skills'

/**
 * Turns records, oldest first, into the detail's messages: the user's prompts, the assistant's
 * text, and one entry per run of consecutive tool calls (how many, and their unique names in
 * order). When the records hold tool details, each call also gets the status its result gives,
 * matched by the call's ID. API errors and interrupts are left out: the detail's callout reports
 * them from the session's facts. Thinking, tool output, and every other record are left out too.
 */
export function claudeMessages(records: readonly ClaudeRecord[]): SessionMessage[] {
  const messages: SessionMessage[] = []
  const results = resultsById(records)
  // A call after the last turn mark can still get its result. One before it never will.
  const lastTurnMark = records.findLastIndex(marksTurn)
  records.forEach((record, index) => {
    if (record.kind === 'prompt') {
      const command = claudeCommand(record.text)
      const skill = claudePromptSkill(records, index)
      const text = command
        ? `/${command.name}${command.args ? '\n' + command.args : ''}`
        : record.text
      messages.push({
        kind: 'prompt',
        text,
        at: record.at,
        ...(skill
          ? { skill: { name: skill.name, path: skill.path, start: 0, end: skill.name.length + 1 } }
          : {})
      })
    } else if (record.kind === 'assistant') {
      if (record.text.trim() !== '') {
        messages.push({ kind: 'reply', text: record.text, at: record.at })
      }
      if (record.toolCalls !== undefined) {
        for (const call of record.toolCalls) {
          const detail = withResult(call, results, index > lastTurnMark)
          addToolCall(messages, detail.name, record.at, detail)
        }
      } else {
        for (const name of record.toolNames) addToolCall(messages, shortToolName(name), record.at)
      }
    }
  })
  return messages
}

/** Results in file order for each call ID. A result is used once, by the first call with its ID. */
function resultsById(records: readonly ClaudeRecord[]): Map<string, ClaudeToolResult[]> {
  const byId = new Map<string, ClaudeToolResult[]>()
  for (const record of records) {
    if (record.kind !== 'tool-result') continue
    for (const result of record.results) {
      if (result.id === null) continue
      byId.set(result.id, [...(byId.get(result.id) ?? []), result])
    }
  }
  return byId
}

function withResult(
  call: ClaudeToolCall,
  results: Map<string, ClaudeToolResult[]>,
  inOpenTurn: boolean
): ToolCallDetail {
  const result = call.id === null ? undefined : results.get(call.id)?.shift()
  if (result === undefined) return { ...call.detail, status: inOpenTurn ? 'pending' : 'no-result' }
  return {
    ...call.detail,
    status: result.status,
    ...(result.error !== undefined ? { error: result.error } : {})
  }
}

function addToolCall(
  messages: SessionMessage[],
  name: string,
  at: number,
  detail?: ToolCallDetail
): void {
  const last = messages.at(-1)
  if (last?.kind === 'tool-calls') {
    const names = last.names.includes(name) ? last.names : [...last.names, name]
    messages[messages.length - 1] = {
      ...last,
      count: last.count + 1,
      names,
      ...(detail && (last.calls?.length ?? 0) < TOOL_GROUP_LIMIT
        ? { calls: [...(last.calls ?? []), detail] }
        : {})
    }
  } else {
    messages.push({
      kind: 'tool-calls',
      count: 1,
      names: [name],
      at,
      ...(detail ? { calls: [detail] } : {})
    })
  }
}
