import { describe, expect, it } from 'vitest'
import { TOOL_GROUP_LIMIT, TOOL_INPUT_LIMIT } from '../codex/tool-details'
import { claudeMessages } from './messages'
import { DENIED_MARKER, parseRecord, STOP_MARKER, type ClaudeRecord } from './records'
import {
  assistantLine,
  CWD,
  interruptLine,
  promptLine,
  SECOND,
  T0,
  toolResultLine
} from './test-records'
import {
  claudeToolCall,
  ERROR_LIMIT,
  errorExcerpt,
  shortToolName,
  SUMMARY_LIMIT
} from './tool-details'

// Every input below is invented and only ever displayed.

function summary(name: string, input: unknown): string | null | undefined {
  return claudeToolCall(name, T0, input, CWD).summary
}

function detailRecords(lines: string[]): ClaudeRecord[] {
  return lines.flatMap((line) => parseRecord(line, { includeToolDetails: true }) ?? [])
}

function call(name: string, id: string, input: unknown, at: number): string {
  return assistantLine([{ type: 'tool_use', name, id, input }], at, { stopReason: 'tool_use' })
}

describe('claudeToolCall', () => {
  it('sums up each known tool in one line, with paths inside the folder made relative', () => {
    expect(summary('Bash', { command: 'git status', description: 'Show the working tree' })).toBe(
      'Show the working tree'
    )
    expect(summary('Bash', { command: '\n  npm   test\nnpm run lint' })).toBe('npm test')
    expect(summary('Read', { file_path: `${CWD}/src/a.ts`, offset: 120, limit: 61 })).toBe(
      'src/a.ts · lines 120–180'
    )
    expect(summary('Read', { file_path: `${CWD}/src/a.ts`, offset: 40 })).toBe(
      'src/a.ts · from line 40'
    )
    expect(summary('Read', { file_path: '/elsewhere/b.pdf', pages: '1-3' })).toBe(
      '/elsewhere/b.pdf · pages 1-3'
    )
    expect(
      summary('Edit', { file_path: `${CWD}/a.ts`, old_string: 'one\ntwo', new_string: 'three' })
    ).toBe('a.ts · −2 +1 lines')
    expect(
      summary('Edit', {
        file_path: `${CWD}/a.ts`,
        old_string: 'x',
        new_string: '',
        replace_all: true
      })
    ).toBe('a.ts · −1 +0 lines · all matches')
    expect(summary('Write', { file_path: `${CWD}/notes.md`, content: 'a\nb\n' })).toBe(
      'notes.md · 2 lines'
    )
    expect(summary('Grep', { pattern: 'TODO', path: `${CWD}/src` })).toBe('TODO in src')
    expect(summary('Glob', { pattern: '**/*.ts' })).toBe('**/*.ts')
    expect(summary('WebFetch', { url: 'https://example.invalid/page', prompt: 'Read it' })).toBe(
      'https://example.invalid/page'
    )
    expect(summary('Agent', { description: 'Find the parser', prompt: 'Long brief' })).toBe(
      'Find the parser'
    )
    expect(summary('TodoWrite', { todos: [{}, {}, {}] })).toBe('3 to-dos')
    expect(summary('AskUserQuestion', { questions: [{ question: 'Which layout?' }] })).toBe(
      'Which layout?'
    )
    expect(summary('mcp__docs__search', { limit: 5, query: 'synthetic query' })).toBe(
      'synthetic query'
    )
    expect(summary('Unknown', { count: 3 })).toBeNull()
    expect(summary('Bash', {})).toBeNull()
    expect(summary('Bash', 'not an object')).toBeNull()
  })

  it('bounds the summary to one line', () => {
    const line = summary('Bash', { description: 'x'.repeat(SUMMARY_LIMIT + 1) })
    expect(line).toBe(`${'x'.repeat(SUMMARY_LIMIT)}…`)
  })

  it('shows the field that matters for known tools and JSON for the rest', () => {
    expect(claudeToolCall('Bash', T0, { command: 'ls -la', description: 'List' }, CWD)).toEqual({
      name: 'Bash',
      at: T0,
      input: 'ls -la',
      inputLength: 6,
      nestedNames: null,
      summary: 'List'
    })
    expect(claudeToolCall('Write', T0, { file_path: '/a', content: 'body' }, CWD).input).toBe(
      'body'
    )
    expect(claudeToolCall('Task', T0, { description: 'd', prompt: 'brief' }, CWD).input).toBe(
      'brief'
    )
    const edit = claudeToolCall(
      'Edit',
      T0,
      { file_path: '/a', old_string: 'one\ntwo', new_string: 'three' },
      CWD
    )
    expect(edit).toMatchObject({ input: '-one\n-two\n+three', inputFormat: 'diff' })
    expect(claudeToolCall('Read', T0, { file_path: '/a', limit: 2 }, CWD).input).toBe(
      '{\n  "file_path": "/a",\n  "limit": 2\n}'
    )
    expect(claudeToolCall('Read', T0, {}, CWD).input).toBe('')
    expect(claudeToolCall('Read', T0, undefined, CWD)).toMatchObject({
      input: null,
      inputLength: 0,
      summary: null
    })
  })

  it('keeps the first characters of a long input and its full length', () => {
    const command = 'echo synthetic; '.repeat(TOOL_INPUT_LIMIT)
    const detail = claudeToolCall('Bash', T0, { command }, CWD)
    expect(detail.input).toHaveLength(TOOL_INPUT_LIMIT)
    expect(detail.inputLength).toBe(command.length)
  })
})

describe('shortToolName', () => {
  it('drops the MCP prefix and an ID-shaped server, and keeps a named server', () => {
    expect(shortToolName('mcp__00000000-0000-4000-8000-000000000001__web_search')).toBe(
      'web_search'
    )
    expect(shortToolName('mcp__docs__search_pages')).toBe('search_pages (docs)')
    expect(shortToolName('Bash')).toBe('Bash')
    expect(shortToolName('mcp__incomplete')).toBe('mcp__incomplete')
  })
})

describe('errorExcerpt', () => {
  it('removes the tool_use_error wrapper and bounds the text', () => {
    expect(errorExcerpt('<tool_use_error>File not found</tool_use_error>\n')).toBe('File not found')
    expect(errorExcerpt('e'.repeat(ERROR_LIMIT + 5))).toBe(`${'e'.repeat(ERROR_LIMIT)}…`)
  })
})

describe('tool details in records', () => {
  it('reads inputs and results only when the detail asks', () => {
    const use = call('Bash', 'toolu_a', { command: 'false' }, T0)
    const result = toolResultLine(T0 + SECOND, true, { id: 'toolu_a', content: 'Exit code 1' })
    expect(parseRecord(use)).not.toHaveProperty('toolCalls')
    expect(parseRecord(result)).toMatchObject({ kind: 'other' })
    expect(parseRecord(result, { includeToolDetails: true })).toEqual({
      kind: 'tool-result',
      at: T0 + SECOND,
      version: '2.1.295',
      results: [{ id: 'toolu_a', status: 'failed', error: 'Exit code 1' }]
    })
  })

  it('tells done, failed, and interrupted results apart', () => {
    const [done, stopped, denied, interrupted] = detailRecords([
      toolResultLine(T0, false, { id: 'a' }),
      toolResultLine(T0, true, { id: 'b', content: STOP_MARKER }),
      toolResultLine(T0, true, { id: 'c', content: DENIED_MARKER }),
      toolResultLine(T0, false, { id: 'd', interrupted: true })
    ])
    const statuses = [done, stopped, denied, interrupted].map((record) =>
      record?.kind === 'tool-result' ? record.results : null
    )
    expect(statuses).toEqual([
      [{ id: 'a', status: 'done' }],
      [{ id: 'b', status: 'interrupted' }],
      [{ id: 'c', status: 'interrupted' }],
      [{ id: 'd', status: 'interrupted' }]
    ])
  })
})

describe('claudeMessages with tool details', () => {
  it('matches each result to its call and marks calls that are still open', () => {
    const messages = claudeMessages(
      detailRecords([
        promptLine('Synthetic prompt.', T0),
        call('Bash', 'toolu_a', { command: 'true', description: 'Works' }, T0 + SECOND),
        call('Bash', 'toolu_b', { command: 'false', description: 'Fails' }, T0 + 2 * SECOND),
        toolResultLine(T0 + 3 * SECOND, false, { id: 'toolu_a' }),
        toolResultLine(T0 + 4 * SECOND, true, { id: 'toolu_b', content: 'Exit code 1' }),
        call('mcp__docs__search', 'toolu_c', { query: 'q' }, T0 + 5 * SECOND)
      ])
    )
    expect(messages[1]).toMatchObject({
      kind: 'tool-calls',
      count: 3,
      names: ['Bash', 'search (docs)'],
      calls: [
        { summary: 'Works', status: 'done' },
        { summary: 'Fails', status: 'failed', error: 'Exit code 1' },
        { name: 'search (docs)', summary: 'q', status: 'pending' }
      ]
    })
    // Output of a call that worked is never kept.
    expect(JSON.stringify(messages)).not.toContain('Synthetic tool output.')
  })

  it('says a call without a result has none once the turn moved on', () => {
    const messages = claudeMessages(
      detailRecords([
        call('Bash', 'toolu_a', { command: 'sleep 9' }, T0),
        interruptLine(STOP_MARKER, T0 + SECOND),
        promptLine('Next.', T0 + 2 * SECOND)
      ])
    )
    expect(messages[0]).toMatchObject({ calls: [{ status: 'no-result' }] })
  })

  it('uses each result once when calls share an ID', () => {
    const messages = claudeMessages(
      detailRecords([
        call('Read', 'same', {}, T0),
        toolResultLine(T0 + 1, false, { id: 'same' }),
        call('Read', 'same', {}, T0 + 2)
      ])
    )
    expect(messages[0]).toMatchObject({ calls: [{ status: 'done' }, { status: 'pending' }] })
  })

  it('keeps details for the first calls of a long group and counts them all', () => {
    const lines = Array.from({ length: TOOL_GROUP_LIMIT + 1 }, (_, i) =>
      call('Read', `toolu_${i}`, {}, T0 + i)
    )
    const [group] = claudeMessages(detailRecords(lines))
    expect(group).toMatchObject({ count: TOOL_GROUP_LIMIT + 1 })
    expect(group?.kind === 'tool-calls' ? group.calls : []).toHaveLength(TOOL_GROUP_LIMIT)
  })
})
