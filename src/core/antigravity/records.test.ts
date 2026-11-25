import { describe, expect, it } from 'vitest'
import { antigravityMessages } from './messages'
import {
  type AntigravityRecord,
  isFinalReply,
  parseAnnotationTitle,
  parseRecord,
  replyCursor,
  requestedSkill,
  userRequestText
} from './records'
import {
  finalReplyLine,
  SECOND,
  skillBlock,
  systemMessageLine,
  T0,
  toolRequestLine,
  toolResultLine,
  unknownStepLine,
  userInputLine
} from './test-records'
import { EMPTY_ANTIGRAVITY_TURN_STATE, foldAntigravityRecords } from './turn-state'
import type { SessionMessage } from '../session'

function parse(lines: string[], includeText = false): AntigravityRecord[] {
  return lines
    .map((line) => parseRecord(line, { includeText }))
    .filter((record): record is AntigravityRecord => record !== null)
}

// One synthetic turn as observed in 2.34.0: prompt, a tool request with commentary, a tool result,
// a failed tool result, and the final reply.
const TURN = [
  userInputLine({ step: 0, text: 'Synthetic question one' }),
  toolRequestLine({ step: 1, tools: ['read_file', 'read_file'], commentary: 'Synthetic aside' }),
  toolResultLine({ step: 2 }),
  toolResultLine({ step: 3, status: 'ERROR' }),
  finalReplyLine({ step: 4, text: 'Synthetic **answer** one' })
]

describe('parseRecord', () => {
  it('reads the observed step types without their text by default', () => {
    expect(parse(TURN)).toEqual([
      {
        kind: 'user-input',
        step: 0,
        at: T0,
        stamp: new Date(T0).toISOString(),
        status: 'done',
        truncated: false
      },
      expect.objectContaining({
        kind: 'planner-response',
        step: 1,
        hasContent: true,
        toolCalls: ['read_file'],
        toolCallCount: 2
      }),
      expect.objectContaining({ kind: 'tool-result', step: 2, status: 'done' }),
      expect.objectContaining({ kind: 'tool-result', step: 3, status: 'error' }),
      expect.objectContaining({ kind: 'planner-response', step: 4, toolCalls: null })
    ])
    for (const record of parse(TURN)) expect(record).not.toHaveProperty('text')
  })

  it('reads text only when asked, without metadata, thinking or output', () => {
    const records = parse(TURN, true)
    expect(records[0]).toMatchObject({ text: 'Synthetic question one' })
    expect(records[4]).toMatchObject({ text: 'Synthetic **answer** one' })
    const serialized = JSON.stringify(records)
    for (const hidden of ['ADDITIONAL_METADATA', 'thinking', 'tool output']) {
      expect(serialized).not.toContain(hidden)
    }
  })

  it('reads tool arguments, errors, and typed result steps only on the detail path', () => {
    const lines = [
      toolRequestLine({ step: 1, tools: ['run_command'] }),
      toolResultLine({ step: 2, status: 'ERROR', error: 'Synthetic failure' }),
      toolResultLine({ step: 3, type: 'VIEW_FILE' }),
      toolResultLine({ step: 4, type: 'ERROR_MESSAGE', error: 'Synthetic system failure' }),
      unknownStepLine({ step: 5 })
    ]
    expect(JSON.stringify(parse(lines))).not.toMatch(/synthetic-argument|failure|toolStep/i)
    const [request, failed, typed, system] = parse(lines, true)
    expect(request).toMatchObject({ calls: [{ name: 'run_command' }] })
    expect(JSON.stringify(request)).toContain('synthetic-argument')
    expect(failed).toMatchObject({ kind: 'tool-result', error: 'Synthetic failure' })
    expect(typed).toMatchObject({ kind: 'other', toolStep: true, status: 'done' })
    expect(system).toMatchObject({
      toolStep: true,
      failedCall: true,
      status: 'done',
      error: 'Synthetic system failure'
    })
  })

  it('accepts the plausible created_at encodings and rejects non-numeric protobuf fields', () => {
    for (const createdAt of [
      new Date(T0).toISOString(),
      T0,
      T0 / 1000,
      { seconds: T0 / 1000, nanos: 0 },
      { seconds: String(T0 / 1000), nanos: 0 }
    ]) {
      expect(parseRecord(unknownStepLine({ step: 7, createdAt }))).toMatchObject({
        at: T0,
        step: 7
      })
    }
    for (const createdAt of [
      { seconds: true, nanos: 0 },
      { seconds: '', nanos: 0 },
      { seconds: null, nanos: 0 },
      { seconds: T0 / 1000, nanos: true },
      { seconds: T0 / 1000, nanos: -1 },
      { seconds: T0 / 1000, nanos: 1_000_000_000 }
    ]) {
      expect(parseRecord(unknownStepLine({ step: 7, createdAt }))).toBeNull()
    }
  })

  it('skips lines without the step fields and identifies unknown types', () => {
    for (const line of [
      'not json',
      '{"step_index": 1',
      '[]',
      JSON.stringify({ type: 'USER_INPUT', created_at: new Date(T0).toISOString() }),
      JSON.stringify({ step_index: -1, type: 'GENERIC', created_at: new Date(T0).toISOString() }),
      JSON.stringify({ step_index: 1.5, type: 'GENERIC', created_at: new Date(T0).toISOString() }),
      JSON.stringify({ step_index: 1, type: 'GENERIC', created_at: 'not a time' }),
      JSON.stringify({ step_index: 1, created_at: new Date(T0).toISOString() })
    ]) {
      expect(parseRecord(line)).toBeNull()
    }
    expect(parseRecord(unknownStepLine({ step: 3 }))).toMatchObject({ kind: 'other', step: 3 })
    // A USER_INPUT that is not from the user is not a prompt.
    const other = JSON.parse(userInputLine({ step: 0, text: 'x' })) as Record<string, unknown>
    expect(parseRecord(JSON.stringify({ ...other, source: 'SYSTEM' }))).toMatchObject({
      kind: 'other'
    })
  })

  it('marks truncated content and cut tool calls', () => {
    const reply = parseRecord(finalReplyLine({ step: 2, text: 'Cut', truncated: ['content'] }))
    expect(reply).toMatchObject({ truncated: true })
    const base = JSON.parse(
      toolRequestLine({ step: 3, tools: [], commentary: 'Synthetic commentary' })
    ) as Record<string, unknown>
    for (const payload of [
      { ...base, tool_calls: '[cut]', truncated_fields: ['tool_calls'] },
      { ...base, tool_calls: [], truncated_fields: ['tool_calls'] },
      { ...base, tool_calls: null, truncated_fields: ['tool_calls'] },
      { ...base, tool_calls: undefined, truncated_fields: ['tool_calls'] }
    ]) {
      const record = parseRecord(JSON.stringify(payload))
      expect(record).toMatchObject({ toolCalls: [], toolCallCount: 1 })
      expect(record && isFinalReply(record)).toBe(false)
    }
  })

  it('never treats a tool request, an empty answer, or an unfinished step as a final reply', () => {
    const records = parse([
      toolRequestLine({ step: 1, tools: ['run_command'], commentary: 'Synthetic aside' }),
      finalReplyLine({ step: 2, text: '   ' }),
      finalReplyLine({ step: 3, text: 'Synthetic', status: 'RUNNING' }),
      finalReplyLine({ step: 4, text: 'Synthetic final' })
    ])
    expect(records.map(isFinalReply)).toEqual([false, false, false, true])
    expect(replyCursor(records[3]!)).toBe(`4:${new Date(T0 + 4 * SECOND).toISOString()}`)
  })
})

describe('userRequestText', () => {
  it('keeps only the user request', () => {
    expect(
      userRequestText(
        '<USER_REQUEST>\n Synthetic ask \n</USER_REQUEST>\n<ADDITIONAL_METADATA>m</ADDITIONAL_METADATA>'
      )
    ).toBe('Synthetic ask')
    expect(
      userRequestText(
        '<USER_REQUEST>\nFix parsing of <USER_REQUEST>x</USER_REQUEST> in records.ts\n</USER_REQUEST>\n<ADDITIONAL_METADATA>m</ADDITIONAL_METADATA>'
      )
    ).toBe('Fix parsing of <USER_REQUEST>x</USER_REQUEST> in records.ts')
    // Metadata that quotes the closing tag never becomes prompt text.
    expect(
      userRequestText(
        '<USER_REQUEST>\nSynthetic ask\n</USER_REQUEST>\n<ADDITIONAL_METADATA>Synthetic file: </USER_REQUEST> end</ADDITIONAL_METADATA>'
      )
    ).toBe('Synthetic ask')
    expect(
      userRequestText(
        '<USER_REQUEST>Synthetic ask</USER_REQUEST><USER_SETTINGS_CHANGE>s</USER_REQUEST>'
      )
    ).toBe('Synthetic ask')
    // Truncation can cut the closing tag, or the metadata tag after it.
    expect(userRequestText('<USER_REQUEST>Synthetic cut')).toBe('Synthetic cut')
    expect(userRequestText('<USER_REQUEST>Synthetic ask</USER_REQUEST>\n<ADDITIONAL_MET')).toBe(
      'Synthetic ask'
    )
    expect(userRequestText('<USER_REQUEST>Synthetic </USER_REQUEST> inside, then cut')).toBe(
      'Synthetic </USER_REQUEST> inside, then cut'
    )
    expect(
      userRequestText(
        'Synthetic bare <ADDITIONAL_METADATA>m</ADDITIONAL_METADATA><USER_SETTINGS_CHANGE>s'
      )
    ).toBe('Synthetic bare')
  })
})

describe('requestedSkill', () => {
  const PATH = '/Users/synthetic/.gemini/config/skills/synthetic-pr/SKILL.md'
  const content = (request: string, metadata: string) =>
    `<USER_REQUEST>\n${request}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\n${metadata}\n</ADDITIONAL_METADATA>`

  it('reads the one skill block in the metadata', () => {
    expect(requestedSkill(content('/synthetic-pr go', skillBlock('synthetic-pr', PATH)))).toEqual({
      name: 'synthetic-pr',
      path: PATH
    })
  })

  it('ignores a block the user typed, two blocks, odd wording, and unsafe names or paths', () => {
    const block = skillBlock('synthetic-pr', PATH)
    expect(requestedSkill(content(block, 'Synthetic metadata.'))).toBeNull()
    expect(requestedSkill(content('/synthetic-pr', block + block))).toBeNull()
    expect(requestedSkill(content('/x', block.replace('requested', 'asked')))).toBeNull()
    expect(requestedSkill(content('/x', skillBlock('bad name', PATH)))).toBeNull()
    for (const path of [
      'relative/SKILL.md',
      '/Users/synthetic/../SKILL.md',
      '/Users/a/README.md'
    ]) {
      expect(requestedSkill(content('/x', skillBlock('synthetic-pr', path)))).toBeNull()
    }
    expect(requestedSkill('<SKILL>no request</SKILL>')).toBeNull()
  })
})

describe('parseAnnotationTitle', () => {
  it('reads the top-level title string', () => {
    expect(parseAnnotationTitle('title: "Synthetic plan"\n')).toBe('Synthetic plan')
    expect(parseAnnotationTitle('# comment title: "no"\ntitle:\'Single\'\n')).toBe('Single')
    expect(parseAnnotationTitle('title: "Split " "title"')).toBe('Split title')
    expect(parseAnnotationTitle('subtitle: "No"\ntitle: "Yes"')).toBe('Yes')
  })

  it('decodes escapes and UTF-8 bytes', () => {
    expect(parseAnnotationTitle('title: "Tab\\there \\"q\\""')).toBe('Tab here "q"')
    // "é" as octal bytes, "ü" as hex bytes, and a raw "ö".
    expect(parseAnnotationTitle('title: "caf\\303\\251 \\xc3\\xbc ö \\u00e8"')).toBe('café ü ö è')
  })

  it('ignores nested titles and returns null when there is no usable title', () => {
    expect(parseAnnotationTitle('meta { title: "Nested" }\nother: 1')).toBeNull()
    expect(parseAnnotationTitle('meta < title: "Nested" > title: "Top"')).toBe('Top')
    for (const text of [
      '',
      'title: ""',
      'title: "  "',
      'title: 5',
      'title: "unterminated\n',
      'x: 1'
    ]) {
      expect(parseAnnotationTitle(text)).toBeNull()
    }
  })
})

describe('foldAntigravityRecords', () => {
  const fold = (lines: string[]) =>
    foldAntigravityRecords(EMPTY_ANTIGRAVITY_TURN_STATE, parse(lines))

  it('follows a turn from prompt to final reply', () => {
    expect(fold(TURN.slice(0, 1)).lastTurnStep).toBe('open')
    expect(fold(TURN.slice(0, 2)).lastTurnStep).toBe('open')
    // A tail that starts mid-turn, on a tool result, is open.
    expect(fold([toolResultLine({ step: 9 })]).lastTurnStep).toBe('open')
    // A failed tool result does not end the turn.
    expect(fold(TURN.slice(0, 4))).toMatchObject({ lastTurnStep: 'open', lastReply: null })
    expect(fold(TURN)).toEqual({
      lastTurnStep: 'ended',
      lastReply: {
        cursor: `4:${new Date(T0 + 4 * SECOND).toISOString()}`,
        completedAt: T0 + 4 * SECOND,
        isError: false,
        errorCode: null,
        newerTurnStarted: false
      },
      lastReplyStep: 4,
      lastRecordAt: T0 + 4 * SECOND,
      lastStep: 4,
      lastUserStep: 0
    })
  })

  it('marks the reply seen when a newer prompt starts, and keeps its cursor', () => {
    const state = fold([...TURN, userInputLine({ step: 5, text: 'Synthetic question two' })])
    expect(state.lastTurnStep).toBe('open')
    expect(state.lastReply).toMatchObject({
      cursor: fold(TURN).lastReply?.cursor,
      newerTurnStarted: true
    })
  })

  it('gives the same reply identity when appended or reread from the tail', () => {
    const whole = fold(TURN)
    const appended = foldAntigravityRecords(fold(TURN.slice(0, 2)), parse(TURN.slice(2)))
    expect(appended).toEqual(whole)
  })

  it('ignores replayed steps, so an old reply is never new again', () => {
    const replay = [...TURN, userInputLine({ step: 5, text: 'Two' }), ...TURN]
    const state = fold(replay)
    expect(state).toMatchObject({ lastTurnStep: 'open', lastStep: 5 })
    expect(state.lastReply?.newerTurnStarted).toBe(true)
  })

  it('ends a canceled turn only for a recognized step', () => {
    const canceled = fold([TURN[0]!, toolResultLine({ step: 1, status: 'CANCELED' })])
    expect(canceled).toMatchObject({ lastTurnStep: 'ended', lastReply: null })
    const unknown = fold([
      unknownStepLine({ step: 0, status: 'CANCELED' }),
      systemMessageLine({ step: 1, status: 'CANCELLED' })
    ])
    expect(unknown).toMatchObject({
      lastTurnStep: null,
      lastReply: null,
      lastUserStep: null,
      lastStep: null
    })
    const openAfterUnknownCancel = fold([
      TURN[0]!,
      unknownStepLine({ step: 1, status: 'CANCELED' }),
      systemMessageLine({ step: 2, status: 'CANCELLED' })
    ])
    expect(openAfterUnknownCancel).toMatchObject({
      lastTurnStep: 'open',
      lastReply: null,
      lastStep: 0
    })
  })
})

const withoutCalls = (message: SessionMessage) => {
  if (message.kind !== 'tool-calls') return message
  const rest = { ...message }
  delete rest.calls
  return rest
}

describe('antigravityMessages', () => {
  it('shows prompts, final replies, and grouped tool calls only', () => {
    const lines = [
      ...TURN,
      userInputLine({ step: 5, text: 'Synthetic question two', truncated: ['content'] }),
      toolRequestLine({ step: 6, tools: ['run_command'] }),
      toolResultLine({ step: 7 }),
      toolRequestLine({ step: 8, tools: ['read_file', 'grep_search'] }),
      toolResultLine({ step: 9 }),
      finalReplyLine({ step: 10, text: 'Synthetic answer two', truncated: ['content'] })
    ]
    expect(antigravityMessages(parse(lines, true)).map(withoutCalls)).toEqual([
      { kind: 'prompt', text: 'Synthetic question one', at: T0 },
      { kind: 'tool-calls', count: 2, names: ['read_file'], at: T0 + SECOND },
      { kind: 'reply', text: 'Synthetic **answer** one', at: T0 + 4 * SECOND },
      { kind: 'prompt', text: 'Synthetic question two', at: T0 + 5 * SECOND, truncated: true },
      {
        kind: 'tool-calls',
        count: 3,
        names: ['run_command', 'read_file', 'grep_search'],
        at: T0 + 6 * SECOND
      },
      { kind: 'reply', text: 'Synthetic answer two', at: T0 + 10 * SECOND, truncated: true }
    ])
  })

  it('leaves out system messages, empty prompts, canceled tool requests, and replayed steps', () => {
    const lines = [
      systemMessageLine({ step: 0 }),
      userInputLine({ step: 1, text: '' }),
      finalReplyLine({ step: 2, text: 'Synthetic only reply' }),
      finalReplyLine({ step: 2, text: 'Synthetic replay' }),
      toolRequestLine({ step: 3, tools: ['run_command'], status: 'CANCELED' })
    ]
    expect(antigravityMessages(parse(lines, true))).toEqual([
      { kind: 'reply', text: 'Synthetic only reply', at: T0 + 2 * SECOND }
    ])
  })

  it('gives each call its input, summary, and the status of the step in its place', () => {
    const lines = [
      userInputLine({ step: 0, text: 'Synthetic question' }),
      toolRequestLine({
        step: 1,
        tools: ['read_file', 'run_command', 'edit_file'],
        args: [
          { Path: '/Users/synthetic/a.md', StartLine: '3', EndLine: '9' },
          { CommandLine: 'echo synthetic', toolSummary: 'Synthetic summary', toolAction: 'Run' },
          { Path: '/Users/synthetic/b.md', Target: 'old', Replacement: 'new\nmore' }
        ]
      }),
      toolResultLine({ step: 2 }),
      toolResultLine({ step: 3, status: 'ERROR', error: '  Synthetic failure  ' }),
      toolResultLine({ step: 4, status: 'CANCELED' }),
      toolRequestLine({ step: 5, tools: ['view_file', 'list_dir'] }),
      toolResultLine({ step: 6, type: 'VIEW_FILE' }),
      toolResultLine({ step: 7, type: 'ERROR_MESSAGE', error: 'Synthetic system failure' }),
      toolRequestLine({ step: 8, tools: ['grep_search', 'search_web'] }),
      finalReplyLine({ step: 9, text: 'Synthetic answer' }),
      toolRequestLine({ step: 10, tools: ['run_command', 'run_command'] }),
      toolResultLine({ step: 11, status: 'RUNNING' })
    ]
    const messages = antigravityMessages(parse(lines, true))
    const groups = messages.filter((message) => message.kind === 'tool-calls')
    expect(groups.map((group) => group.calls?.map((call) => call.status))).toEqual([
      // Step 8 asked for two calls, but step 9 is the final reply: neither got a result.
      ['done', 'failed', 'interrupted', 'done', 'failed', 'no-result', 'no-result'],
      ['pending', 'pending']
    ])
    const [read, run, edit, , system] = groups[0]!.calls!
    expect(read).toMatchObject({ name: 'read_file', summary: '/Users/synthetic/a.md · lines 3–9' })
    expect(run).toMatchObject({
      summary: 'Synthetic summary',
      input: 'echo synthetic',
      error: 'Synthetic failure'
    })
    expect(edit).toMatchObject({ input: '-old\n+new\n+more', inputFormat: 'diff' })
    expect(system).toMatchObject({ error: 'Synthetic system failure' })
  })

  it('shows tool inputs as JSON without the descriptions Antigravity adds, bounded', () => {
    const long = 'x'.repeat(7000)
    const lines = [
      toolRequestLine({
        step: 1,
        tools: ['call_mcp_tool', 'write_file', 'update_focus'],
        args: [
          { ServerName: 'synthetic', ToolName: 'lookup', Arguments: '{}', toolAction: 'Call' },
          { Path: '/Users/synthetic/c.md', Content: long },
          'not an object'
        ]
      })
    ]
    const [mcp, write, odd] = (
      antigravityMessages(parse(lines, true))[0] as {
        calls: { summary: string | null; input: string | null; inputLength: number }[]
      }
    ).calls
    expect(mcp).toMatchObject({ summary: 'lookup (synthetic)' })
    expect(JSON.parse(mcp!.input!)).toEqual({
      ServerName: 'synthetic',
      ToolName: 'lookup',
      Arguments: '{}'
    })
    expect(write).toMatchObject({ inputLength: 7000, summary: '/Users/synthetic/c.md' })
    expect(write!.input).toHaveLength(6000)
    expect(odd).toMatchObject({ input: null, summary: null })
  })

  it('puts the requested skill on a /name prompt', () => {
    const path = '/Users/synthetic/.gemini/config/skills/synthetic-pr/SKILL.md'
    const lines = [
      userInputLine({
        step: 0,
        text: '/synthetic-pr open it',
        metadata: skillBlock('synthetic-pr', path)
      }),
      userInputLine({ step: 1, text: 'Use it please', metadata: skillBlock('synthetic-pr', path) })
    ]
    expect(antigravityMessages(parse(lines, true))).toEqual([
      {
        kind: 'prompt',
        text: '/synthetic-pr open it',
        at: T0,
        skill: { name: 'synthetic-pr', path, start: 0, end: 13 }
      },
      {
        kind: 'prompt',
        text: 'Use it please',
        at: T0 + SECOND,
        skill: { name: 'synthetic-pr', path, start: 0, end: 0 }
      }
    ])
  })
})
