import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { App } from './App'
import { createSessionsStore } from './sessions-store'
import { fakeApi, session, snapshot } from '../test-support'

function setup() {
  const first = session('alpha', { activity: { state: 'idle' } })
  const second = session('beta', {
    summary: {
      ...first.summary,
      title: 'Other project',
      workspacePath: '/synthetic/tools',
      lastActivityAt: first.summary.lastActivityAt + 1
    },
    key: { tool: 'claude', id: 'beta' }
  })
  const fake = fakeApi(snapshot([first, second]))
  Object.defineProperty(window, 'agentpeek', { value: fake.api, configurable: true })
  const store = createSessionsStore(fake.api)
  render(<App store={store} />)
  return { ...fake, store, first, second }
}

describe('Find Session', () => {
  it('searches metadata across the current view/filter and opens with keyboard without reading other results', async () => {
    const { api, store, second } = setup()
    await screen.findByRole('button', { name: 'All Sessions 2' })
    store.setFilter('codex')
    await userEvent.click(screen.getByRole('button', { name: 'Find Session' }))
    const dialog = screen.getByRole('dialog', { name: 'Find Session' })
    const input = within(dialog).getByRole('combobox')
    await userEvent.type(input, 'TOOLS BETA')
    expect(within(dialog).getAllByRole('option')).toHaveLength(1)
    expect(api.getMessages).not.toHaveBeenCalled()
    await userEvent.keyboard('{Enter}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(store.getSnapshot().selection?.session.key).toEqual(second.key)
    expect(store.getSnapshot().filter).toBe('codex')
    expect(api.getMessages).toHaveBeenCalledWith(second.key, 20)
  })

  it('handles no matches, live result removal, ArrowDown and cancellation without changing panes', async () => {
    const { command, push, first, api, store } = setup()
    await screen.findByRole('button', { name: 'All Sessions 2' })
    act(() => command('quick-open'))
    const input = screen.getByRole('combobox')
    await userEvent.type(input, 'absent')
    expect(screen.getByText(/No matching sessions/)).toBeTruthy()
    await userEvent.keyboard('{Enter}')
    expect(screen.getByRole('dialog')).toBeTruthy()
    await userEvent.clear(input)
    await userEvent.keyboard('{ArrowDown}')
    act(() => push(snapshot([first])))
    expect(screen.getAllByRole('option')).toHaveLength(1)
    await userEvent.click(screen.getByRole('button', { name: 'Close Find Session' }))
    expect(store.getSnapshot().selection).toBeNull()
    expect(api.getMessages).not.toHaveBeenCalled()
  })

  it('pauses covered reading and restores the same pane when cancelled', async () => {
    const { store, api } = setup()
    await userEvent.click(await screen.findByRole('button', { name: 'All Sessions 2' }))
    await userEvent.click(screen.getByRole('treeitem', { name: /^Synthetic alpha,/ }))
    await screen.findByText('No recent messages.')
    const selected = store.getSnapshot().selection?.session.key
    api.getMessages.mockClear()
    await userEvent.click(screen.getByRole('button', { name: 'Find Session' }))
    expect(store.getSnapshot().targetReady).toBe(false)
    expect(api.setSelection).toHaveBeenLastCalledWith(null, { secondPaneOpen: false })
    await userEvent.type(screen.getByRole('combobox'), 'alpha')
    expect(api.getMessages).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Close Find Session' }))
    expect(store.getSnapshot().selection?.session.key).toEqual(selected)
  })

  it('allows unpinning an unavailable saved pin without attempting a transcript read', async () => {
    const pin = session('missing', {
      unavailable: true,
      pinned: true,
      activity: { state: 'unknown', reason: 'unreadable' }
    })
    const fake = fakeApi(snapshot([pin]))
    Object.defineProperty(window, 'agentpeek', { value: fake.api, configurable: true })
    render(<App />)
    await userEvent.click(await screen.findByRole('button', { name: 'Pinned 1' }))
    await userEvent.click(screen.getByRole('treeitem', { name: /^Synthetic missing,/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Unpin' }))
    expect(fake.api.setPinned).toHaveBeenCalledWith(pin.key, false)
    expect(fake.api.getMessages).not.toHaveBeenCalled()
    act(() => fake.push(snapshot([])))
    expect(screen.queryByRole('treeitem', { name: /Synthetic missing/ })).toBeNull()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Pin' }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Open Codex' }).disabled).toBe(
      true
    )
  })
})
