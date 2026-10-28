import { describe, expect, it } from 'vitest'
import { claudeMessages } from './messages'
import { parseRecord } from './records'
import { claudeCommand } from './skills'
import { assistantLine, metaUserLine, promptLine, T0 } from './test-records'
import { readClaudeSkill } from '../../main/sessions/claude-skill-reader'

const path = '/synthetic/.claude/skills/task-visualize/SKILL.md'
const command =
  '<command-message>task-visualize</command-message>\n<command-name>/task-visualize</command-name>\n<command-args>Show the synthetic result.\nKeep this line.</command-args>'
const prompt = promptLine(command, T0)
const meta = (
  text = '# Synthetic recorded skill',
  flags: Record<string, boolean> = { isMeta: true }
) => metaUserLine(`Base directory for this skill: ${path.slice(0, -9)}\n\n${text}`, T0 + 1, flags)
const messages = (lines: string[]) =>
  claudeMessages(lines.flatMap((line) => parseRecord(line, { includeSkills: true }) ?? []))
const request = { at: T0, name: 'task-visualize', path }

describe('Claude slash skill requests', () => {
  it('shows a skill card reference with literal arguments and reads only its recorded copy', () => {
    const lines = [prompt, meta()]
    expect(messages(lines)).toEqual([
      {
        kind: 'prompt',
        at: T0,
        text: '/task-visualize\nShow the synthetic result.\nKeep this line.',
        skill: { name: 'task-visualize', path, start: 0, end: 15 }
      }
    ])
    expect(readClaudeSkill(lines, request)).toMatchObject({
      kind: 'skill',
      source: 'conversation',
      text: '# Synthetic recorded skill'
    })
    expect(parseRecord(meta())).toMatchObject({ kind: 'other' })
    expect(JSON.stringify(messages(lines))).not.toContain('Synthetic recorded skill')
  })

  it('keeps unknown commands readable without guessing a skill file', () => {
    expect(messages([prompt])[0]).toEqual({
      kind: 'prompt',
      at: T0,
      text: '/task-visualize\nShow the synthetic result.\nKeep this line.'
    })
    for (const text of [
      'Example:\n' + command,
      '```\n' + command + '\n```',
      '> ' + command,
      command.replace('/task-visualize<', '/other<'),
      '/task-visualize'
    ])
      expect(claudeCommand(text)).toBeNull()
  })

  it('never borrows a skill from a later turn, assistant example, compact summary or sidechain', () => {
    const reply = assistantLine([{ type: 'text', text: 'Synthetic reply' }], T0 + 1)
    for (const lines of [
      [meta(), prompt],
      [prompt, promptLine('Next synthetic turn', T0 + 1), meta()],
      [prompt, reply, meta()],
      [prompt, meta('# Synthetic', { isMeta: true, isCompactSummary: true })],
      [prompt, meta('# Synthetic', { isMeta: true, isSidechain: true })],
      [prompt, meta('# Synthetic', { isMeta: false })],
      [prompt, meta().replace('skills/task-visualize', 'skills/other')]
    ]) {
      expect(messages(lines)[0]).not.toHaveProperty('skill')
      expect(readClaudeSkill(lines, request)).toEqual({ kind: 'unavailable', reason: 'not-found' })
    }
  })

  it('requires the exact time, name and path on every expansion; caps content and supports plugin names', () => {
    for (const change of [{ at: T0 + 1 }, { name: 'other' }, { path: '/other/SKILL.md' }])
      expect(readClaudeSkill([prompt, meta()], { ...request, ...change })).toEqual({
        kind: 'unavailable',
        reason: 'not-found'
      })
    expect(readClaudeSkill([], request)).toEqual({ kind: 'unavailable', reason: 'not-found' })
    expect(readClaudeSkill([prompt, meta('x'.repeat(60_001))], request)).toMatchObject({
      kind: 'skill',
      truncated: true
    })
    expect(
      messages([prompt.replaceAll('task-visualize', 'synthetic:task-visualize'), meta()])[0]
    ).toHaveProperty('skill.name', 'synthetic:task-visualize')
  })
})
