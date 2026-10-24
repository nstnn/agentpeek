import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { SessionMessage, ToolCallDetail } from '../../core/session'
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
    const view = render(<ToolCalls message={group([call])} />)
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
    view.rerender(<ToolCalls message={group([call, { ...call, at: call.at + 1000 }])} />)
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
      />
    )
    expect(
      screen.getByText('Showing the first 50 of 51 calls. Open Codex for the full group.')
    ).toBeTruthy()
    view.rerender(
      <ToolCalls message={{ kind: 'tool-calls', count: 2, names: ['Read', 'Bash'], at: call.at }} />
    )
    expect(screen.getByText('2 tool calls · Read, Bash')).toBeTruthy()
    expect(view.container.querySelector('details')).toBeNull()
  })
})
