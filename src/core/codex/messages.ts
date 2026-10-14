import type { SessionMessage } from '../session'
import type { CodexRecord } from './records'

/**
 * Turns records, oldest first, into the detail's messages: prompts, replies, and one entry per run
 * of consecutive tool calls (how many, and their unique names in order). Reasoning and every other
 * record are left out.
 */
export function codexMessages(records: readonly CodexRecord[]): SessionMessage[] {
  const messages: SessionMessage[] = []
  for (const record of records) {
    switch (record.kind) {
      case 'user-message':
        messages.push({ kind: 'prompt', text: record.text, at: record.at })
        break
      case 'agent-message':
        messages.push({ kind: 'reply', text: record.text, at: record.at })
        break
      case 'tool-call': {
        const last = messages.at(-1)
        if (last?.kind === 'tool-calls') {
          const names = last.names.includes(record.name) ? last.names : [...last.names, record.name]
          messages[messages.length - 1] = { ...last, count: last.count + 1, names }
        } else {
          messages.push({ kind: 'tool-calls', count: 1, names: [record.name], at: record.at })
        }
        break
      }
      default:
        break
    }
  }
  return messages
}
