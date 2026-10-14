import type { SessionMessage } from '../session'
import type { ClaudeRecord } from './records'

/**
 * Turns records, oldest first, into the detail's messages: the user's prompts, the assistant's
 * text, and one entry per run of consecutive tool calls (how many, and their unique names in
 * order). API errors and interrupts are left out: the detail's callout reports them from the
 * session's facts. Thinking, tool results, and every other record are left out too.
 */
export function claudeMessages(records: readonly ClaudeRecord[]): SessionMessage[] {
  const messages: SessionMessage[] = []
  for (const record of records) {
    if (record.kind === 'prompt') {
      messages.push({ kind: 'prompt', text: record.text, at: record.at })
    } else if (record.kind === 'assistant') {
      if (record.text.trim() !== '') {
        messages.push({ kind: 'reply', text: record.text, at: record.at })
      }
      for (const name of record.toolNames) addToolCall(messages, name, record.at)
    }
  }
  return messages
}

function addToolCall(messages: SessionMessage[], name: string, at: number): void {
  const last = messages.at(-1)
  if (last?.kind === 'tool-calls') {
    const names = last.names.includes(name) ? last.names : [...last.names, name]
    messages[messages.length - 1] = { ...last, count: last.count + 1, names }
  } else {
    messages.push({ kind: 'tool-calls', count: 1, names: [name], at })
  }
}
