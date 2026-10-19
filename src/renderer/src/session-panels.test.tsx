import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { App } from './App'
import { createSessionsStore } from './sessions-store'
import { fakeApi, NOW, session, snapshot } from '../test-support'
import type { ToolHealth } from '../../core/health'
import type { AppSnapshot } from '../../shared/api'
import type { AgentTool } from '../../core/tools'
import { toolName, VIEW_NAMES } from './session-display'

function mount(initial: AppSnapshot) {
  const fake = fakeApi(initial)
  Object.defineProperty(window, 'agentpeek', { value: fake.api, configurable: true })
  render(<App store={createSessionsStore(fake.api)} />)
  return fake
}

describe('empty states and health', () => {
  it.each([
    ['checking', { state: 'checking' }, 'Reading sessions…'],
    ['not installed', { state: 'not-installed' }, "Codex isn't installed"],
    ['no access', { state: 'no-access', lastReadAt: null }, "Can't read Codex files"],
    ['unsupported', { state: 'unsupported', toolVersion: '2.3.0' }, 'Unsupported format']
  ] as [string, ToolHealth, string][])(
    'shows the filtered %s state without hiding the other source',
    async (_name, health, title) => {
      const fake = mount(
        snapshot([session('pin', { key: { tool: 'claude', id: 'pin' }, pinned: true })], {
          health: { codex: health, claude: { state: 'connected', lastReadAt: NOW } }
        })
      )
      await screen.findByRole('option')
      act(() => fake.command('view:pinned'))
      await userEvent.click(await screen.findByRole('radio', { name: 'Codex 0' }))
      expect(screen.getByRole('heading', { name: title })).toBeTruthy()
      expect(screen.getByText('Connected')).toBeTruthy()
      expect(screen.queryByRole('button', { name: /Show All|Browse All/ })).toBeNull()
    }
  )

  it('shows no sessions, empty Pinned, and Active clear with Show All Sessions', async () => {
    const fake = mount(snapshot([]))
    await screen.findByRole('heading', { name: 'No sessions yet' })
    act(() => fake.command('view:pinned'))
    expect(screen.getByRole('heading', { name: 'No pinned sessions' })).toBeTruthy()
    expect(screen.getByText('Pin a session to keep it here (⇧⌘P).')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Browse All Sessions' }))
    expect(screen.getByRole('heading', { name: 'All Sessions', level: 1 })).toBeTruthy()
    act(() => {
      fake.push(snapshot([session('idle', { activity: { state: 'idle' } })]))
      fake.command('view:active')
    })
    await userEvent.click(screen.getByRole('button', { name: 'Show All Sessions' }))
    expect(screen.getByRole('heading', { name: 'All Sessions', level: 1 })).toBeTruthy()
    expect(screen.getByRole('option')).toBeTruthy()
  })

  describe.each(['codex', 'claude'] as AgentTool[])('%s filter', (tool) => {
    const otherTool = tool === 'codex' ? 'claude' : 'codex'
    it.each(['pinned', 'active', 'all'] as const)(
      'clears only the tool filter from an empty %s view and restores keyboard focus',
      async (view) => {
        const fake = mount(
          snapshot([session('hidden', { key: { tool: otherTool, id: 'hidden' }, pinned: true })])
        )
        await screen.findByRole('option')
        act(() => fake.command(`view:${view}`))
        await userEvent.click(screen.getByRole('radio', { name: `${toolName(tool)} 0` }))
        const scope = view === 'pinned' ? 'pinned ' : view === 'active' ? 'active ' : ''
        expect(
          screen.getByRole('heading', { name: `No ${scope}${toolName(tool)} sessions` })
        ).toBeTruthy()
        expect(screen.getByRole('button', { name: 'Pinned 1' })).toBeTruthy()
        const action = screen.getByRole('button', {
          name:
            view === 'pinned'
              ? 'Show All Pinned'
              : view === 'active'
                ? 'Show All Active'
                : 'Show All Sessions'
        })
        action.focus()
        await userEvent.keyboard('{Enter}')
        expect(screen.getByRole('heading', { name: VIEW_NAMES[view], level: 1 })).toBeTruthy()
        expect(screen.getByRole('option', { name: /Synthetic hidden/ })).toBeTruthy()
        const all = screen.getByRole('radio', { name: 'All 1' })
        expect(all.getAttribute('aria-checked')).toBe('true')
        expect(document.activeElement).toBe(all)
        await userEvent.keyboard('{Tab}{ArrowDown}')
        expect(document.activeElement).toBe(screen.getByRole('listbox'))
        expect(screen.getByRole('option').getAttribute('aria-selected')).toBe('true')
      }
    )

    it('offers browse for zero pins even with sessions in the other tool, preserving the filter', async () => {
      const fake = mount(
        snapshot([
          session('other', { key: { tool: otherTool, id: 'other' }, activity: { state: 'idle' } })
        ])
      )
      await screen.findByRole('heading', { name: 'Nothing needs you right now' })
      await userEvent.click(screen.getByRole('radio', { name: `${toolName(tool)} 0` }))
      act(() => fake.command('view:pinned'))
      expect(screen.getByRole('heading', { name: 'No pinned sessions' })).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'Show All Pinned' })).toBeNull()
      await userEvent.click(screen.getByRole('button', { name: 'Browse All Sessions' }))
      expect(screen.getByRole('heading', { name: 'All Sessions', level: 1 })).toBeTruthy()
      expect(
        screen.getByRole('radio', { name: `${toolName(tool)} 0` }).getAttribute('aria-checked')
      ).toBe('true')
      expect(document.activeElement).toBe(
        screen.getByRole('radio', { name: `${toolName(tool)} 0` })
      )
      await userEvent.click(screen.getByRole('button', { name: 'Show All Sessions' }))
      expect(screen.getByRole('option', { name: /Synthetic other/ })).toBeTruthy()
    })

    it('shows pins in both tools and retains the filter across view changes', async () => {
      const fake = mount(
        snapshot([
          session('codex-pin', { pinned: true }),
          session('claude-pin', { key: { tool: 'claude', id: 'claude-pin' }, pinned: true })
        ])
      )
      await screen.findAllByRole('option')
      await userEvent.click(screen.getByRole('radio', { name: `${toolName(tool)} 1` }))
      act(() => fake.command('view:pinned'))
      expect(screen.getAllByRole('option')).toHaveLength(1)
      expect(screen.getByRole('option').getAttribute('id')).toBe(`session-${tool}:${tool}-pin`)
      expect(screen.getByRole('button', { name: 'Pinned 2' })).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'Show All Pinned' })).toBeNull()
    })

    it('names the tool when no source has any sessions', async () => {
      const fake = mount(snapshot())
      await screen.findByRole('heading', { name: 'No sessions yet' })
      await userEvent.click(screen.getByRole('radio', { name: `${toolName(tool)} 0` }))
      expect(
        screen.getByRole('heading', { name: `No ${toolName(tool)} sessions yet` })
      ).toBeTruthy()
      act(() => fake.command('view:all'))
      expect(
        screen.getByRole('heading', { name: `No ${toolName(tool)} sessions yet` })
      ).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'Show All Sessions' })).toBeNull()
    })
  })

  it('keeps Active globally empty with idle sessions instead of promising hidden active rows', async () => {
    mount(snapshot([session('idle', { activity: { state: 'idle' } })]))
    await screen.findByRole('heading', { name: 'Nothing needs you right now' })
    await userEvent.click(screen.getByRole('radio', { name: 'Claude Code 0' }))
    expect(screen.getByRole('heading', { name: 'Nothing needs you right now' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Show All Active' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Show All Sessions' }))
    expect(screen.getByRole('heading', { name: 'No Claude Code sessions' })).toBeTruthy()
  })

  it('explains zero Active attention with seven running sessions and keeps totals unfiltered', async () => {
    mount(snapshot(Array.from({ length: 7 }, (_, i) => session(`running-${i}`))))
    const active = await screen.findByRole('button', { name: 'Active, 0 sessions need attention' })
    expect(active.getAttribute('title')).toContain("Running alone doesn't need attention")
    expect(active.getAttribute('title')).toContain('across both tools')
    expect(active.querySelector('.badge')).toBeNull()
    expect(screen.getAllByRole('option')).toHaveLength(7)
    await userEvent.click(screen.getByRole('radio', { name: 'Claude Code 0' }))
    expect(screen.getByRole('button', { name: 'Active, 0 sessions need attention' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'All Sessions 7' })).toBeTruthy()
  })

  it('counts each waiting/error/reply session once and names the Active badge meaning', async () => {
    mount(
      snapshot([
        session('waiting', {
          activity: { state: 'waiting', waitingFor: 'permission prompt' },
          attention: { waiting: true, error: true, newReply: true }
        }),
        session('error', {
          activity: { state: 'idle' },
          attention: { waiting: false, error: true, newReply: false }
        }),
        session('reply', {
          key: { tool: 'claude', id: 'reply' },
          activity: { state: 'idle' },
          attention: { waiting: false, error: false, newReply: true }
        }),
        session('running')
      ])
    )
    const active = await screen.findByRole('button', { name: 'Active, 3 sessions need attention' })
    expect(within(active).getByText('3')).toBeTruthy()
    expect(active.getAttribute('title')).toContain('Waiting, unread replies or errors')
    expect(screen.getAllByRole('option')).toHaveLength(4)
    await userEvent.click(screen.getByRole('radio', { name: 'Claude Code 1' }))
    expect(screen.getAllByRole('option')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Active, 3 sessions need attention' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'All Sessions 4' })).toBeTruthy()
  })

  it('renders mixed health and state-file warnings, then removes them on recovery', async () => {
    const fake = mount(
      snapshot([], {
        health: {
          codex: { state: 'no-access', lastReadAt: NOW },
          claude: { state: 'unsupported', toolVersion: '2.3.0' }
        },
        localState: { kind: 'unavailable', reason: 'newer-version' }
      })
    )
    await screen.findByText(/was made by a newer version/)
    expect(screen.getByText(/Last updated/)).toBeTruthy()
    expect(screen.getByText(/Its sessions show as Unknown/)).toBeTruthy()
    act(() => fake.push(snapshot()))
    expect(screen.queryByText(/won't be saved/)).toBeNull()
    expect(screen.queryByText(/Its sessions show as Unknown/)).toBeNull()
    expect(screen.getAllByText('Connected')).toHaveLength(2)
  })

  it('uses distinct copy for an unreadable local state file', async () => {
    mount(snapshot([], { localState: { kind: 'unavailable', reason: 'unreadable' } }))
    expect((await screen.findByText(/saved state can't be read/)).textContent).toContain(
      'so it was left unchanged'
    )
  })
  it('shows the approved failed-save copy and removes it after a successful save', async () => {
    const fake = mount(snapshot())
    await screen.findByRole('heading', { name: 'No sessions yet' })
    act(() =>
      fake.push(snapshot([], { localState: { kind: 'unavailable', reason: 'unwritable' } }))
    )
    expect(screen.getByText(/AgentPeek can't save its state file/).textContent).toBe(
      "Pins and read markers won't be saved. AgentPeek can't save its state file. Changes you make now last until you quit."
    )
    expect(screen.queryByText(/so it was left unchanged/)).toBeNull()
    act(() => fake.push(snapshot()))
    expect(screen.queryByText(/won't be saved/)).toBeNull()
  })
})
