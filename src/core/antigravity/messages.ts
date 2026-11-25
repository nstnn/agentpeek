import type { SessionMessage, ToolCallDetail, ToolCallStatus } from '../session'
import type { SkillMention } from '../skill-names'
import { TOOL_GROUP_LIMIT } from '../codex/tool-details'
import { errorExcerpt } from '../claude/tool-details'
import { type AntigravityRecord, isFinalReply } from './records'

/**
 * Turns records read with text, oldest first, into the detail's messages: the user's prompts, the
 * final replies, and one entry per run of steps that asked for tools (how many calls, the tools'
 * unique names in order, and each call's bounded input and status). Tool output, commentary next
 * to tool requests, `thinking`, and system messages are left out; a failed call keeps the start of
 * its error. A prompt or reply that Antigravity cut short in `transcript.jsonl` is marked
 * `truncated` (DECISION-003). A `/name` prompt carries the skill it asked for.
 */
export function antigravityMessages(records: readonly AntigravityRecord[]): SessionMessage[] {
  const messages: SessionMessage[] = []
  const byStep = new Map<number, AntigravityRecord>()
  for (const record of records) if (!byStep.has(record.step)) byStep.set(record.step, record)
  const lastStep = records.reduce((last, record) => Math.max(last, record.step), -1)
  let previousStep: number | null = null
  for (const record of records) {
    if (record.kind === 'system-message' || record.kind === 'other') continue
    if (previousStep !== null && record.step <= previousStep) continue
    previousStep = record.step
    if (record.status === 'canceled') continue
    if (record.kind === 'user-input') {
      const text = record.text ?? ''
      if (text === '') continue
      const skill = record.skill === undefined ? null : skillMention(text, record.skill)
      messages.push({
        kind: 'prompt',
        text,
        at: record.at,
        ...(skill !== null ? { skill } : {}),
        ...(record.truncated ? { truncated: true as const } : {})
      })
    } else if (record.kind === 'planner-response' && isFinalReply(record)) {
      messages.push({
        kind: 'reply',
        text: record.text ?? '',
        at: record.at,
        ...(record.truncated ? { truncated: true as const } : {})
      })
    } else if (record.kind === 'planner-response' && record.toolCalls !== null) {
      const calls = record.calls?.map((call, index) =>
        withResult(call, record.step + 1 + index, byStep, lastStep)
      )
      const last = messages.at(-1)
      if (last?.kind === 'tool-calls') {
        const names = [...last.names]
        for (const name of record.toolCalls) if (!names.includes(name)) names.push(name)
        const kept = [...(last.calls ?? []), ...(calls ?? [])].slice(0, TOOL_GROUP_LIMIT)
        messages[messages.length - 1] = {
          ...last,
          count: last.count + record.toolCallCount,
          names,
          ...(kept.length > 0 ? { calls: kept } : {})
        }
      } else {
        messages.push({
          kind: 'tool-calls',
          count: record.toolCallCount,
          names: [...record.toolCalls],
          at: record.at,
          ...(calls?.length ? { calls: calls.slice(0, TOOL_GROUP_LIMIT) } : {})
        })
      }
    }
  }
  return messages
}

/**
 * The status the call's own step gives: the step at `resultStep`. A step there that is no tool's
 * result means the call never got one. With no step there yet, the call is pending only while
 * nothing later was written.
 */
function withResult(
  call: ToolCallDetail,
  resultStep: number,
  byStep: ReadonlyMap<number, AntigravityRecord>,
  lastStep: number
): ToolCallDetail {
  const result = byStep.get(resultStep)
  if (result === undefined) {
    return { ...call, status: resultStep > lastStep ? 'pending' : 'no-result' }
  }
  if (result.kind !== 'tool-result' && !(result.kind === 'other' && result.toolStep === true)) {
    return { ...call, status: 'no-result' }
  }
  const status: ToolCallStatus =
    result.kind === 'other' && result.failedCall === true
      ? 'failed'
      : result.status === 'done'
        ? 'done'
        : result.status === 'error'
          ? 'failed'
          : result.status === 'canceled'
            ? 'interrupted'
            : 'pending'
  const error =
    status === 'failed' && 'error' in result && typeof result.error === 'string'
      ? errorExcerpt(result.error)
      : ''
  return { ...call, status, ...(error !== '' ? { error } : {}) }
}

/**
 * Where the skill card goes: in place of a leading `/name`, as typed; otherwise before the text.
 */
function skillMention(text: string, skill: { name: string; path: string }): SkillMention {
  const command = `/${skill.name}`
  const typed = text.startsWith(command) && /^(?:\s|$)/.test(text.slice(command.length))
  return { ...skill, start: 0, end: typed ? command.length : 0 }
}
