import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { App } from './App'
import { createSessionsStore } from './sessions-store'
import { fakeApi, NOW, session, snapshot } from '../test-support'
import type { ToolHealth } from '../../core/health'
import type { AppSnapshot } from '../../shared/api'

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
      mount(
        snapshot([], { health: { codex: health, claude: { state: 'connected', lastReadAt: NOW } } })
      )
      await userEvent.click(await screen.findByRole('radio', { name: 'Codex 0' }))
      expect(screen.getByRole('heading', { name: title })).toBeTruthy()
      expect(screen.getByText('Connected')).toBeTruthy()
    }
  )

  it('shows no sessions, empty Pinned, and Active clear with Show All Sessions', async () => {
    const fake = mount(snapshot([]))
    await screen.findByRole('heading', { name: 'No sessions yet' })
    act(() => fake.command('view:pinned'))
    expect(screen.getByRole('heading', { name: 'No pinned sessions' })).toBeTruthy()
    act(() => {
      fake.push(snapshot([session('idle', { activity: { state: 'idle' } })]))
      fake.command('view:active')
    })
    await userEvent.click(screen.getByRole('button', { name: 'Show All Sessions' }))
    expect(screen.getByRole('heading', { name: 'All Sessions', level: 1 })).toBeTruthy()
    expect(screen.getByRole('option')).toBeTruthy()
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
