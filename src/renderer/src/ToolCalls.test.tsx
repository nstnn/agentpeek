import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { SessionMessage, ToolCallDetail } from '../../core/session'
import { clockTime } from './detail-status'
import { ToolCalls } from './ToolCalls'

const call: ToolCallDetail = {
  name: 'exec',
  at: 1768467600000,
  input: 'await tools.Read({})',
  inputLength: 20,
  nestedNames: ['Read']
}
function group(
  calls: ToolCallDetail[],
  count = calls.length
): Extract<SessionMessage, { kind: 'tool-calls' }> {
  return { kind: 'tool-calls', count, names: ['exec'], at: call.at, calls }
}

describe('tool call disclosures', () => {
  it('starts collapsed, reveals input on demand and keeps disclosure through a live append', async () => {
    const view = render(<ToolCalls message={group([call])} tool="codex" activity="idle" />)
    const outer = view.container.querySelector('details')!
    const inner = view.container.querySelector('.tool-call') as HTMLDetailsElement
    expect(outer.open).toBe(false)
    expect(inner.open).toBe(false)
    await userEvent.click(screen.getByText('1 tool call · exec'))
    await userEvent.click(screen.getByText('Read'))
    expect(outer.open).toBe(true)
    expect(inner.open).toBe(true)
    expect(screen.getByText(call.input!)).toBeTruthy()
    expect(screen.getByText('Names detected from input; execution is not confirmed.')).toBeTruthy()
    view.rerender(
      <ToolCalls
        message={group([call, { ...call, at: call.at + 1000 }])}
        tool="codex"
        activity="idle"
      />
    )
    expect(outer.open).toBe(true)
    expect(inner.open).toBe(true)
    expect(view.container.querySelectorAll('.tool-call')).toHaveLength(2)
    await userEvent.click(screen.getByText('2 tool calls · exec'))
    expect(outer.open).toBe(false)
  })

  it('shows raw input as inert text and distinguishes unknown, missing, empty and truncated input', () => {
    const hostile =
      '<script>globalThis.syntheticInjected = true</script><img src="https://example.invalid/a">'
    const { container } = render(
      <ToolCalls
        message={group([
          { ...call, input: hostile, inputLength: hostile.length, nestedNames: [] },
          { ...call, input: null, inputLength: 0, nestedNames: null },
          { ...call, input: '', inputLength: 0, nestedNames: null },
          { ...call, input: 'x'.repeat(6000), inputLength: 6001, nestedNames: [] }
        ])}
        tool="codex"
        activity="idle"
      />
    )
    expect(container.querySelector('script,img,a,iframe')).toBeNull()
    expect(container.textContent).toContain(hostile)
    expect(screen.getByText('Input is not available in this record.')).toBeTruthy()
    expect(screen.getByText('Recorded input (empty)')).toBeTruthy()
    expect(
      screen.getByText(
        'Showing the first 6,000 of 6,001 characters. Open Codex for the full input.'
      )
    ).toBeTruthy()
    expect(screen.getByText('This input does not identify a specific nested tool.')).toBeTruthy()
    expect(
      screen.getByText('Nested names are unavailable because the input is truncated.')
    ).toBeTruthy()
  })

  it('discloses a capped group and preserves name-only summaries for other sources', () => {
    const view = render(
      <ToolCalls
        message={group(
          Array.from({ length: 50 }, () => call),
          51
        )}
        tool="codex"
        activity="idle"
      />
    )
    expect(
      screen.getByText('Showing the first 50 of 51 calls. Open Codex for the full group.')
    ).toBeTruthy()
    view.rerender(
      <ToolCalls
        message={{ kind: 'tool-calls', count: 2, names: ['Read', 'Bash'], at: call.at }}
        tool="claude"
        activity="idle"
      />
    )
    expect(screen.getByText('2 tool calls · Read, Bash')).toBeTruthy()
    expect(view.container.querySelector('details')).toBeNull()
  })

  it('leads Claude calls with their summary and labels each status against the activity', async () => {
    const claudeCall: ToolCallDetail = {
      name: 'Bash',
      at: call.at,
      input: 'npm test',
      inputLength: 8,
      nestedNames: null,
      summary: 'Run the synthetic tests'
    }
    const calls: ToolCallDetail[] = [
      { ...claudeCall, status: 'done' },
      { ...claudeCall, summary: 'Break on purpose', status: 'failed', error: 'Exit code 1' },
      { ...claudeCall, summary: null, name: 'Read', status: 'interrupted' },
      { ...claudeCall, summary: 'Still going', status: 'pending' }
    ]
    const message: Extract<SessionMessage, { kind: 'tool-calls' }> = {
      kind: 'tool-calls',
      count: 4,
      names: ['Bash', 'Read'],
      at: call.at,
      calls
    }
    const view = render(<ToolCalls message={message} tool="claude" activity="running" />)
    const summary = view.container.querySelector('.tool-calls > summary')!
    expect(summary.textContent).toBe('4 tool calls · Bash, Read · 1 failed · 1 running')
    const rows = [...view.container.querySelectorAll('.tool-call > summary')].map(
      (row) => row.textContent
    )
    const time = clockTime(call.at)
    expect(rows).toEqual([
      `1Run the synthetic testsBash${time}`,
      `2Break on purposeBash · Failed${time}`,
      `3ReadInterrupted${time}`,
      `4Still goingBash · Running${time}`
    ])
    await userEvent.click(screen.getByText('Break on purpose'))
    expect(screen.getByText('Exit code 1')).toBeTruthy()
    // The same pending call reads as waiting, then as without a result, as the session changes.
    view.rerender(<ToolCalls message={message} tool="claude" activity="waiting" />)
    expect(summary.textContent).toBe('4 tool calls · Bash, Read · 1 failed · 1 waiting')
    view.rerender(<ToolCalls message={message} tool="claude" activity="idle" />)
    expect(summary.textContent).toBe('4 tool calls · Bash, Read · 1 failed')
    expect(rows.length).toBe(4)
    expect(view.container.querySelectorAll('.tool-call-status.muted')).toHaveLength(2)
  })

  it('marks edit lines and names Claude in truncation notices', () => {
    const { container } = render(
      <ToolCalls
        message={{
          kind: 'tool-calls',
          count: 2,
          names: ['Edit'],
          at: call.at,
          calls: [
            {
              name: 'Edit',
              at: call.at,
              input: '-old line\n+new line',
              inputLength: 9000,
              nestedNames: null,
              summary: 'a.ts · −1 +1 lines',
              inputFormat: 'diff',
              status: 'done'
            }
          ]
        }}
        tool="claude"
        activity="idle"
      />
    )
    expect(container.querySelector('.diff-removed')?.textContent).toBe('-old line\n')
    expect(container.querySelector('.diff-added')?.textContent).toBe('+new line')
    expect(
      screen.getByText('Showing the first 19 of 9,000 characters. Open Claude for the full input.')
    ).toBeTruthy()
    expect(
      screen.getByText('Showing the first 1 of 2 calls. Open Claude for the full group.')
    ).toBeTruthy()
  })
})
