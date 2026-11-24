import type { SessionMessage } from '../session'
import { type AntigravityRecord, isFinalReply } from './records'

/**
 * Turns records read with text, oldest first, into the detail's messages: the user's prompts, the
 * final replies, and one entry per run of steps that asked for tools (how many calls, and the
 * tools' unique names in order). Tool arguments and results, commentary next to tool requests,
 * `thinking`, and system messages are left out. A prompt or reply that Antigravity cut short in
 * `transcript.jsonl` is marked `truncated` (DECISION-003).
 */
export function antigravityMessages(records: readonly AntigravityRecord[]): SessionMessage[] {
  const messages: SessionMessage[] = []
  let lastStep: number | null = null
  for (const record of records) {
    if (record.kind === 'system-message' || record.kind === 'other') continue
    if (lastStep !== null && record.step <= lastStep) continue
    lastStep = record.step
    if (record.status === 'canceled') continue
    if (record.kind === 'user-input') {
      const text = record.text ?? ''
      if (text === '') continue
      messages.push({
        kind: 'prompt',
        text,
        at: record.at,
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
      const last = messages.at(-1)
      if (last?.kind === 'tool-calls') {
        const names = [...last.names]
        for (const name of record.toolCalls) if (!names.includes(name)) names.push(name)
        messages[messages.length - 1] = { ...last, count: last.count + record.toolCallCount, names }
      } else {
        messages.push({
          kind: 'tool-calls',
          count: record.toolCallCount,
          names: [...record.toolCalls],
          at: record.at
        })
      }
    }
  }
  return messages
}
