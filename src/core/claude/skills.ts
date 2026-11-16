import { isSkillName, isSkillPath } from '../skill-names'
import type { ClaudeRecord } from './records'

/** Only a complete command envelope, never quoted examples or arbitrary slash text. */
export function claudeCommand(text: string): { name: string; args: string } | null {
  const match =
    /^\s*<command-message>([^<>\r\n]+)<\/command-message>\r?\n<command-name>\/([^<>\r\n]+)<\/command-name>(?:\r?\n<command-args>([\s\S]*)<\/command-args>)?\s*$/.exec(
      text
    )
  if (!match || match[1] !== match[2] || !isSkillName(match[1])) return null
  return { name: match[1], args: match[3] ?? '' }
}

/** Claude's injected skill copy is conversation data, never instructions for AgentPeek. */
export function claudeSkillText(text: string): { path: string; text: string } | null {
  const match = /^Base directory for this skill: ([^\r\n]+)\r?\n\r?\n([\s\S]*)$/.exec(text)
  if (!match) return null
  const path = match[1]!.replace(/\/$/, '') + '/SKILL.md'
  return isSkillPath(path) ? { path, text: match[2]! } : null
}

/** Bind only the next injected skill, before any assistant activity or new human turn. */
export function claudePromptSkill(records: readonly ClaudeRecord[], index: number) {
  const prompt = records[index]
  if (prompt?.kind !== 'prompt') return null
  const command = claudeCommand(prompt.text)
  if (!command) return null
  for (let i = index + 1; i < records.length; i++) {
    const record = records[i]!
    if (record.kind === 'other' || record.kind === 'custom-title') continue
    if (record.kind !== 'skill') return null
    // Namespaced plugin commands use plugin:skill; the recorded directory names the skill.
    const directory = record.path.split('/').at(-2)
    if (directory !== command.name.split(':').at(-1)) return null
    return { name: command.name, path: record.path, text: record.text }
  }
  return null
}
