import { describe, expect, it } from 'vitest'
import { codexMessages } from './messages'
import { parseRecord } from './records'
import { rolloutLine, T0 } from './test-records'
import { toolCallDetail, TOOL_GROUP_LIMIT, TOOL_INPUT_LIMIT } from './tool-details'

describe('on-demand Codex tool details', () => {
  it('finds unique direct tool calls in source order, including multiple calls in one exec', () => {
    const input = `await Promise.all([
      tools.exec_command({ cmd: "synthetic" }),
      tools["mcp__example__read"]({}),
      tools.exec_command({ cmd: "synthetic again" })
    ])`
    expect(toolCallDetail('exec', T0, input)).toEqual({
      name: 'exec',
      at: T0,
      input,
      inputLength: input.length,
      nestedNames: ['exec_command', 'mcp__example__read']
    })
  })

  it('ignores comments, strings, regular expressions, member references and dynamic names', () => {
    const input = String.raw`
      // tools.Comment({})
      const text = 'tools.String({})';
      const template = \`tools.Template({})\`;
      const pattern = /tools.Regex\(\)/;
      const reference = tools.NotCalled;
      await tools[dynamicName]({});
      await other.tools.NotTheToolObject({});
    `.replaceAll('\\`', '`')
    expect(toolCallDetail('functions.exec', T0, input).nestedNames).toEqual([])
  })

  it('reports syntax rather than claiming a call was executed, and never evaluates input', () => {
    const input = 'throw new Error("synthetic"); if (false) await tools.NotExecuted({})'
    expect(toolCallDetail('exec', T0, input).nestedNames).toEqual(['NotExecuted'])
  })

  it('fails closed on malformed or deeply nested JavaScript', () => {
    for (const input of ['await tools.Broken(', '('.repeat(2900) + ')'.repeat(2900)]) {
      expect(toolCallDetail('exec', T0, input).nestedNames).toEqual([])
    }
  })

  it('bounds input and avoids interpreting a truncated prefix as complete JavaScript', () => {
    const input = 'await tools.Read({});\n//' + 'x'.repeat(TOOL_INPUT_LIMIT)
    const detail = toolCallDetail('exec', T0, input)
    expect(detail.input).toHaveLength(TOOL_INPUT_LIMIT)
    expect(detail.inputLength).toBe(input.length)
    expect(detail.nestedNames).toEqual([])
    expect(toolCallDetail('exec', T0, ' '.repeat(TOOL_INPUT_LIMIT)).inputLength).toBe(
      TOOL_INPUT_LIMIT
    )
  })

  it('distinguishes missing input, empty input, and tools whose input is not JavaScript', () => {
    expect(toolCallDetail('exec', T0, {})).toMatchObject({
      input: null,
      inputLength: 0,
      nestedNames: []
    })
    expect(toolCallDetail('exec', T0, '')).toMatchObject({ input: '', inputLength: 0 })
    expect(toolCallDetail('exec_command', T0, '{"cmd":"synthetic"}').nestedNames).toBeNull()
  })

  it('keeps input off the activity path and excludes output even on the detail path', () => {
    for (const type of ['custom_tool_call', 'function_call']) {
      const line = rolloutLine(
        'response_item',
        {
          type,
          name: 'exec',
          input: 'await tools.Read({})',
          arguments: 'await tools.Read({})',
          output: 'Synthetic output must not be retained.'
        },
        T0
      )
      expect(parseRecord(line)).toEqual({ kind: 'tool-call', name: 'exec', at: T0 })
      const detailed = parseRecord(line, { includeToolInputs: true })
      expect(detailed).toMatchObject({ detail: { nestedNames: ['Read'] } })
      expect(JSON.stringify(detailed)).not.toContain('Synthetic output')
    }
    expect(
      parseRecord(
        rolloutLine(
          'response_item',
          {
            type: 'custom_tool_call_output',
            output: 'Synthetic output.'
          },
          T0
        ),
        { includeToolInputs: true }
      )
    ).toEqual({ kind: 'other', at: T0 })
  })

  it('caps retained call details while preserving the full count and summary names', () => {
    const records = Array.from({ length: TOOL_GROUP_LIMIT + 1 }, (_, i) =>
      parseRecord(
        rolloutLine(
          'response_item',
          { type: 'custom_tool_call', name: i === TOOL_GROUP_LIMIT ? 'last' : 'exec', input: '' },
          T0 + i
        ),
        { includeToolInputs: true }
      )!
    )
    const messages = codexMessages(records)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ count: TOOL_GROUP_LIMIT + 1, names: ['exec', 'last'] })
    const group = messages[0]
    if (group?.kind !== 'tool-calls') throw new Error('Expected tool group')
    expect(group.calls).toHaveLength(TOOL_GROUP_LIMIT)
    expect(group.calls?.[TOOL_GROUP_LIMIT - 1]?.at).toBe(T0 + TOOL_GROUP_LIMIT - 1)
  })
})
