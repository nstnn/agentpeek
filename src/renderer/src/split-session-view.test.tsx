import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { RecentMessages, Session } from '../../core/session'
import { fakeApi, NOW, session, snapshot } from '../test-support'
import { App } from './App'
import { createSessionsStore } from './sessions-store'

function mount(sessions = [session('a'), session('b'), session('c'), session('d')]) {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query) =>
      ({
        matches: query === '(min-width: 1300px)',
        addEventListener: vi.fn(),
        removeEventListener: vi.fn()
      }) as unknown as MediaQueryList
  )
  const f = fakeApi(snapshot(sessions))
  f.api.getMessages.mockImplementation((key) =>
    Promise.resolve({
      kind: 'messages',
      hasOlder: false,
      messages: [{ kind: 'reply', text: `${key.id} synthetic line\n`.repeat(500), at: NOW }]
    })
  )
  Object.defineProperty(window, 'agentpeek', { value: f.api, configurable: true })
  const store = createSessionsStore(f.api)
  return { ...f, store, ...render(<App store={store} />) }
}
const pane = (name: 'Main' | 'Second') =>
  screen.getByRole('complementary', { name: `${name} pane` })
const messages = (name: 'Main' | 'Second') =>
  within(pane(name)).getByRole('region', { name: `${name} pane recent messages` })
async function choose(id: string) {
  await userEvent.click(await screen.findByRole('option', { name: new RegExp(`Synthetic ${id},`) }))
}
async function keepMain() {
  await userEvent.click(screen.getByRole('button', { name: 'Open in Second Pane' }))
  await within(pane('Second')).findByRole('button', { name: 'Show More' })
}
const unread = (id: string, error = false): Session =>
  session(id, {
    attention: { waiting: false, newReply: !error, error },
    lastReply: {
      cursor: `${id}-reply`,
      completedAt: NOW,
      isError: error,
      errorCode: error ? 'rate_limit' : null,
      newerTurnStarted: false
    }
  })

describe('roomy split session composition', () => {
  it('keeps slot-local identity, scroll and disclosures across selection, replacement and close', async () => {
    const f = mount()
    await choose('a')
    await keepMain()
    await userEvent.click(within(pane('Second')).getByRole('button', { name: 'Show More' }))
    const secondMessages = messages('Second')
    fireEvent.keyDown(secondMessages, { key: 'PageDown' })
    fireEvent.scroll(secondMessages, { target: { scrollTop: 81 } })
    await choose('c')
    await within(pane('Main')).findByRole('button', { name: 'Show More' })
    expect(messages('Second')).toBe(secondMessages)
    expect(secondMessages.scrollTop).toBe(81)
    expect(within(pane('Second')).getByRole('button', { name: 'Collapse Message' })).toBeTruthy()
    await userEvent.click(within(pane('Main')).getByRole('button', { name: 'Show More' }))
    const mainMessages = messages('Main')
    fireEvent.keyDown(mainMessages, { key: 'PageDown' })
    fireEvent.scroll(mainMessages, { target: { scrollTop: 42 } })
    act(() => f.command({ type: 'open-secondary', key: session('d').key }))
    await within(pane('Second')).findByRole('heading', { name: 'Synthetic d' })
    expect(messages('Main')).toBe(mainMessages)
    expect(mainMessages.scrollTop).toBe(42)
    expect(within(pane('Main')).getByRole('button', { name: 'Collapse Message' })).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Close Second Pane' }))
    expect(screen.queryByRole('complementary', { name: 'Second pane' })).toBeNull()
    expect(screen.getByRole('region', { name: 'Recent messages' })).toBe(mainMessages)
    expect(mainMessages.scrollTop).toBe(42)
    expect(document.activeElement).toBe(
      screen.getByRole('complementary', { name: 'Session detail' })
    )
    expect(f.store.getSnapshot().activePane).toBe('main')
  })

  it('reopens the same Second without reloading, uses distinct controls and keeps one list selection', async () => {
    const f = mount()
    await choose('a')
    await keepMain()
    await userEvent.click(within(pane('Second')).getByRole('button', { name: 'Show More' }))
    const secondMessages = messages('Second')
    const controlled = screen
      .getAllByRole('button', { name: /Show More|Collapse Message/ })
      .map((button) => button.getAttribute('aria-controls'))
    expect(new Set(controlled).size).toBe(2)
    controlled.forEach((id) => expect(document.querySelectorAll(`[id="${id}"]`)).toHaveLength(1))
    expect(screen.getAllByRole('option', { selected: true })).toHaveLength(1)
    expect(screen.getByRole('option', { name: /Synthetic a.*Second pane/ })).toBeTruthy()
    await choose('a')
    f.api.getMessages.mockClear()
    act(() => f.command({ type: 'open-secondary', key: session('a').key }))
    expect(messages('Second')).toBe(secondMessages)
    expect(within(pane('Second')).getByRole('button', { name: 'Collapse Message' })).toBeTruthy()
    expect(document.activeElement).toBe(pane('Second'))
    expect(f.api.getMessages).not.toHaveBeenCalled()
  })

  it('activates on pointer and keyboard entry, binds actions locally and never acknowledges inactive updates', async () => {
    const a = unread('a')
    const b = unread('b', true)
    const f = mount([a, b])
    fireEvent.focus(window)
    await choose('a')
    await keepMain()
    await choose('b')
    await within(pane('Main')).findByRole('button', { name: 'Show More' })
    f.api.markRead.mockClear()
    const updated = { ...a, lastReply: { ...a.lastReply!, cursor: 'a-new' } }
    act(() => f.push(snapshot([updated, b])))
    await vi.waitFor(() => expect(f.api.getMessages).toHaveBeenCalledTimes(4))
    expect(f.api.markRead).not.toHaveBeenCalled()
    const text = within(pane('Second')).getByText(/a synthetic line/)
    fireEvent.pointerDown(text)
    await vi.waitFor(() => expect(f.api.markRead.mock.calls).toEqual([[a.key, 'a-new']]))
    expect(f.api.setSelection).toHaveBeenLastCalledWith(a.key, { secondPaneOpen: true })
    await userEvent.click(within(pane('Main')).getByRole('button', { name: 'Pin' }))
    expect(f.api.setPinned).toHaveBeenLastCalledWith(b.key, true)
    expect(f.api.setSelection).toHaveBeenLastCalledWith(b.key, { secondPaneOpen: true })
    act(() => within(pane('Second')).getByRole('button', { name: 'Pin' }).focus())
    await vi.waitFor(() =>
      expect(f.api.setSelection).toHaveBeenLastCalledWith(a.key, { secondPaneOpen: true })
    )
    expect(document.activeElement).toBe(within(pane('Second')).getByRole('button', { name: 'Pin' }))
  })

  it('isolates source recovery, late results, loading failures and waiting semantics', async () => {
    const waiting = session('b', {
      key: { tool: 'claude', id: 'b' },
      activity: { state: 'waiting', waitingFor: 'permission prompt' },
      attention: { waiting: true, error: false, newReply: false }
    })
    const f = mount([session('a'), waiting])
    await choose('b')
    await keepMain()
    const secondMessages = messages('Second')
    fireEvent.scroll(secondMessages, { target: { scrollTop: 29 } })
    let finish!: (result: RecentMessages) => void
    f.api.getMessages.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    await choose('a')
    expect(within(pane('Main')).getByText('Loading messages…')).toBeTruthy()
    const lastSeen = within(pane('Main')).getByText(/Last seen in AgentPeek/).textContent
    act(() => f.push(snapshot([waiting], { takenAt: NOW + 1000 })))
    act(() =>
      finish({
        kind: 'messages',
        hasOlder: false,
        messages: [{ kind: 'reply', text: 'Stale hidden data', at: NOW }]
      })
    )
    expect(screen.queryByText('Stale hidden data')).toBeNull()
    expect(within(pane('Main')).getByText(/Last seen in AgentPeek/).textContent).toBe(lastSeen)
    f.api.getMessages.mockResolvedValueOnce({ kind: 'unreadable' })
    act(() => f.push(snapshot([session('a'), waiting], { takenAt: NOW + 2000 })))
    await within(pane('Main')).findByRole('button', { name: 'Try Again' })
    expect(messages('Second')).toBe(secondMessages)
    expect(secondMessages.scrollTop).toBe(29)
    expect(within(pane('Second')).getByText('Waiting for you · Permission prompt')).toBeTruthy()
    expect(f.api.markRead).not.toHaveBeenCalled()
  })

  it('retains Second across filters without inserting it or marking an anchored filtered row', async () => {
    const f = mount([session('a'), session('b', { key: { tool: 'claude', id: 'b' } })])
    await choose('a')
    await keepMain()
    const secondMessages = messages('Second')
    await userEvent.click(screen.getByRole('radio', { name: 'Claude Code 1' }))
    expect(screen.getAllByRole('option')).toHaveLength(1)
    expect(screen.queryByRole('option', { name: /Second pane/ })).toBeNull()
    expect(messages('Second')).toBe(secondMessages)
    expect(f.store.getSnapshot().selection).toBeNull()
    await choose('b')
    expect(f.store.getSnapshot().activePane).toBe('main')
    expect(messages('Second')).toBe(secondMessages)
    act(() =>
      f.command({
        type: 'open-secondary',
        key: session('b', { key: { tool: 'claude', id: 'b' } }).key
      })
    )
    act(() => f.push(snapshot([session('a')])))
    expect(
      screen.getByRole('option', { name: /Synthetic b/ }).getAttribute('aria-label')
    ).not.toContain('Second pane')
  })
})
