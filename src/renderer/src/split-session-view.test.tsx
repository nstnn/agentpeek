import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { RecentMessages, Session } from '../../core/session'
import { fakeApi, NOW, session, snapshot } from '../test-support'
import { App } from './App'
import { createSessionsStore } from './sessions-store'
import { mockWorkspaceWidth } from '../workspace-test-support'

function mount(sessions = [session('a'), session('b'), session('c'), session('d')]) {
  mockWorkspaceWidth(1440)
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
  store.setGrouping('status')
  return { ...f, store, ...render(<App store={store} />) }
}
const pane = (name: 'Left' | 'Right') => screen.getByRole('complementary', { name: `${name} pane` })
const messages = (name: 'Left' | 'Right') =>
  within(pane(name)).getByRole('region', { name: `${name} pane recent messages` })
async function choose(id: string) {
  await userEvent.click(await screen.findByRole('option', { name: new RegExp(`Synthetic ${id},`) }))
}
async function keepMain(f: ReturnType<typeof mount>) {
  act(() =>
    f.command({ type: 'open-secondary', key: f.store.getSnapshot().selection!.session.key })
  )
  await within(pane('Right')).findByRole('button', { name: 'Show More' })
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
  it.each(['a', 'b'])(
    'closes Left and keeps Right session %s with its transcript, scroll, disclosures and focus',
    async (id) => {
      const f = mount()
      await choose('a')
      act(() => f.command({ type: 'open-secondary', key: session(id).key }))
      await userEvent.click(await within(pane('Right')).findByRole('button', { name: 'Show More' }))
      const transcript = messages('Right')
      fireEvent.keyDown(transcript, { key: 'PageDown' })
      fireEvent.scroll(transcript, { target: { scrollTop: 81 } })
      const loads = f.api.getMessages.mock.calls.length
      const user = userEvent.setup()
      const close = within(pane('Left')).getByRole('button', { name: 'Close Left Pane' })
      expect(close.textContent).toBe('×')
      expect(
        within(pane('Right')).getByRole('button', { name: 'Close Right Pane' }).textContent
      ).toBe('×')
      act(() => close.focus())
      await user.keyboard('{Enter}')
      const detail = screen.getByRole('complementary', { name: 'Session detail' })
      expect(f.store.getSnapshot()).toMatchObject({
        selection: { session: { key: session(id).key } },
        secondarySelection: null,
        activePane: 'main'
      })
      expect(within(detail).getByRole('region', { name: 'Recent messages' })).toBe(transcript)
      expect(transcript.scrollTop).toBe(81)
      expect(within(detail).getByRole('button', { name: 'Collapse Message' })).toBeTruthy()
      expect(f.api.getMessages.mock.calls.length).toBe(loads)
      expect(f.api.setSelection).toHaveBeenLastCalledWith(session(id).key, {
        secondPaneOpen: false
      })
      expect(document.activeElement).toBe(detail)
      expect(screen.queryByRole('button', { name: /Close (Left|Right) Pane/ })).toBeNull()

      act(() => f.command({ type: 'open-secondary', key: session('c').key }))
      await within(pane('Right')).findByRole('button', { name: 'Show More' })
      await user.click(within(pane('Right')).getByRole('button', { name: 'Close Right Pane' }))
      expect(screen.getByRole('region', { name: 'Recent messages' })).toBe(transcript)
    }
  )

  it('resizes visible columns without replacing transcripts or changing the active session', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 1440
    } as DOMRect)
    const f = mount()
    await choose('a')
    await keepMain(f)
    await userEvent.click(within(pane('Right')).getByRole('button', { name: 'Show More' }))
    const transcript = messages('Right')
    fireEvent.scroll(transcript, { target: { scrollTop: 75 } })
    const activeKey = f.store.getSnapshot().secondarySelection!.session.key
    const loads = f.api.getMessages.mock.calls.length
    const divider = screen.getByRole('separator', { name: 'Synthetic a (Left pane) width' })
    const before = Number(divider.getAttribute('aria-valuenow'))
    fireEvent.keyDown(divider, { key: 'ArrowLeft' })
    expect(Number(divider.getAttribute('aria-valuenow'))).toBe(before - 10)
    fireEvent.keyDown(divider, { key: 'Enter' })
    expect(f.store.getSnapshot().activePane).toBe('second')
    expect(f.store.getSnapshot().secondarySelection!.session.key).toEqual(activeKey)
    expect(messages('Right')).toBe(transcript)
    expect(transcript.scrollTop).toBe(75)
    expect(within(pane('Right')).getByRole('button', { name: 'Collapse Message' })).toBeTruthy()
    expect(f.api.getMessages.mock.calls.length).toBe(loads)
    await userEvent.click(within(pane('Right')).getByRole('button', { name: 'Close Right Pane' }))
    expect(screen.queryByRole('separator', { name: /Left pane.*width/ })).toBeNull()
    expect(screen.getByRole('separator', { name: 'Sidebar width' })).toBeTruthy()
    expect(screen.getByRole('separator', { name: 'Sessions width' })).toBeTruthy()
  })

  it('keeps slot-local identity, scroll and disclosures across selection, replacement and close', async () => {
    const f = mount()
    await choose('a')
    await keepMain(f)
    for (const name of ['Left', 'Right'] as const) {
      expect(within(pane(name)).getAllByRole('heading', { name: 'Synthetic a' })).toHaveLength(1)
      expect(pane(name).querySelector('.detail-title')).toBeNull()
    }
    await userEvent.click(within(pane('Right')).getByRole('button', { name: 'Show More' }))
    const secondMessages = messages('Right')
    fireEvent.keyDown(secondMessages, { key: 'PageDown' })
    fireEvent.scroll(secondMessages, { target: { scrollTop: 81 } })
    fireEvent.pointerDown(pane('Left'))
    await choose('c')
    await within(pane('Left')).findByRole('button', { name: 'Show More' })
    expect(messages('Right')).toBe(secondMessages)
    expect(secondMessages.scrollTop).toBe(81)
    expect(within(pane('Right')).getByRole('button', { name: 'Collapse Message' })).toBeTruthy()
    await userEvent.click(within(pane('Left')).getByRole('button', { name: 'Show More' }))
    const mainMessages = messages('Left')
    fireEvent.keyDown(mainMessages, { key: 'PageDown' })
    fireEvent.scroll(mainMessages, { target: { scrollTop: 42 } })
    act(() => f.command({ type: 'open-secondary', key: session('d').key }))
    await within(pane('Right')).findByRole('heading', { name: 'Synthetic d' })
    expect(messages('Left')).toBe(mainMessages)
    expect(mainMessages.scrollTop).toBe(42)
    expect(within(pane('Left')).getByRole('button', { name: 'Collapse Message' })).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Close Right Pane' }))
    expect(screen.queryByRole('complementary', { name: 'Right pane' })).toBeNull()
    expect(screen.getByRole('region', { name: 'Recent messages' })).toBe(mainMessages)
    expect(mainMessages.scrollTop).toBe(42)
    expect(document.activeElement).toBe(
      screen.getByRole('complementary', { name: 'Session detail' })
    )
    expect(f.store.getSnapshot().activePane).toBe('main')
    expect(
      screen.getByRole('heading', { name: 'Synthetic c' }).closest('.detail-title')
    ).toBeTruthy()
  })

  it('reopens the same Second without reloading, uses distinct controls and keeps one list selection', async () => {
    const f = mount()
    await choose('a')
    await keepMain(f)
    await userEvent.click(within(pane('Right')).getByRole('button', { name: 'Show More' }))
    const secondMessages = messages('Right')
    const controlled = screen
      .getAllByRole('button', { name: /Show More|Collapse Message/ })
      .map((button) => button.getAttribute('aria-controls'))
    expect(new Set(controlled).size).toBe(2)
    controlled.forEach((id) => expect(document.querySelectorAll(`[id="${id}"]`)).toHaveLength(1))
    expect(screen.getAllByRole('option', { selected: true })).toHaveLength(1)
    expect(screen.getByRole('option', { name: /Synthetic a.*Right pane/ })).toBeTruthy()
    await choose('a')
    f.api.getMessages.mockClear()
    act(() => f.command({ type: 'open-secondary', key: session('a').key }))
    expect(messages('Right')).toBe(secondMessages)
    expect(within(pane('Right')).getByRole('button', { name: 'Collapse Message' })).toBeTruthy()
    expect(document.activeElement).toBe(pane('Right'))
    expect(f.api.getMessages).not.toHaveBeenCalled()
  })

  it('activates on pointer and keyboard entry, binds actions locally and never acknowledges inactive updates', async () => {
    const a = unread('a')
    const b = unread('b', true)
    const f = mount([a, b])
    fireEvent.focus(window)
    await choose('a')
    await keepMain(f)
    fireEvent.pointerDown(pane('Left'))
    await choose('b')
    await within(pane('Left')).findByRole('button', { name: 'Show More' })
    f.api.markRead.mockClear()
    const updated = { ...a, lastReply: { ...a.lastReply!, cursor: 'a-new' } }
    act(() => f.push(snapshot([updated, b])))
    await vi.waitFor(() => expect(f.api.getMessages).toHaveBeenCalledTimes(4))
    expect(f.api.markRead).not.toHaveBeenCalled()
    const text = within(pane('Right')).getByText(/a synthetic line/)
    fireEvent.pointerDown(text)
    await vi.waitFor(() => expect(f.api.markRead.mock.calls).toEqual([[a.key, 'a-new']]))
    expect(f.api.setSelection).toHaveBeenLastCalledWith(a.key, { secondPaneOpen: true })
    await userEvent.click(within(pane('Left')).getByRole('button', { name: 'Pin' }))
    expect(f.api.setPinned).toHaveBeenLastCalledWith(b.key, true)
    expect(f.api.setSelection).toHaveBeenLastCalledWith(b.key, { secondPaneOpen: true })
    act(() => within(pane('Right')).getByRole('button', { name: 'Pin' }).focus())
    await vi.waitFor(() =>
      expect(f.api.setSelection).toHaveBeenLastCalledWith(a.key, { secondPaneOpen: true })
    )
    expect(document.activeElement).toBe(within(pane('Right')).getByRole('button', { name: 'Pin' }))
  })

  it('isolates source recovery, late results, loading failures and waiting semantics', async () => {
    const waiting = session('b', {
      key: { tool: 'claude', id: 'b' },
      activity: { state: 'waiting', waitingFor: 'permission prompt' },
      attention: { waiting: true, error: false, newReply: false }
    })
    const f = mount([session('a'), waiting])
    act(() => f.store.setView('all'))
    await choose('b')
    await keepMain(f)
    const secondMessages = messages('Right')
    fireEvent.scroll(secondMessages, { target: { scrollTop: 29 } })
    let finish!: (result: RecentMessages) => void
    f.api.getMessages.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    fireEvent.pointerDown(pane('Left'))
    await choose('a')
    expect(within(pane('Left')).getByText('Loading messages…')).toBeTruthy()
    const lastSeen = within(pane('Left')).getByText(/Last seen in AgentPeek/).textContent
    act(() => f.push(snapshot([waiting], { takenAt: NOW + 1000 })))
    act(() =>
      finish({
        kind: 'messages',
        hasOlder: false,
        messages: [{ kind: 'reply', text: 'Stale hidden data', at: NOW }]
      })
    )
    expect(screen.queryByText('Stale hidden data')).toBeNull()
    expect(within(pane('Left')).getByText(/Last seen in AgentPeek/).textContent).toBe(lastSeen)
    f.api.getMessages.mockResolvedValueOnce({ kind: 'unreadable' })
    act(() => f.push(snapshot([session('a'), waiting], { takenAt: NOW + 2000 })))
    await within(pane('Left')).findByRole('button', { name: 'Try Again' })
    expect(messages('Right')).toBe(secondMessages)
    expect(secondMessages.scrollTop).toBe(29)
    expect(within(pane('Right')).getByText('Waiting for you · Permission prompt')).toBeTruthy()
    expect(f.api.markRead).not.toHaveBeenCalled()
  })

  it('retains Second across filters without inserting it or marking an anchored filtered row', async () => {
    const f = mount([session('a'), session('b', { key: { tool: 'claude', id: 'b' } })])
    await choose('a')
    await keepMain(f)
    const secondMessages = messages('Right')
    await userEvent.click(screen.getByRole('radio', { name: 'Claude Code 1' }))
    expect(screen.getAllByRole('option')).toHaveLength(1)
    expect(screen.queryByRole('option', { name: /Right pane/ })).toBeNull()
    expect(pane('Right')).toBeTruthy()
    expect(f.container.querySelector('[data-pane=second] .transcript')).toBe(secondMessages)
    expect(f.store.getSnapshot().selection?.session.key.id).toBe('a')
    act(() =>
      f.command({
        type: 'open-primary',
        key: session('b', { key: { tool: 'claude', id: 'b' } }).key
      })
    )
    expect(f.store.getSnapshot().activePane).toBe('main')
    expect(messages('Right')).toBe(secondMessages)
    act(() =>
      f.command({
        type: 'open-secondary',
        key: session('b', { key: { tool: 'claude', id: 'b' } }).key
      })
    )
    act(() => f.push(snapshot([session('a')])))
    expect(screen.queryByRole('option', { name: /Synthetic b/ })).toBeNull()
    expect(f.store.getSnapshot().secondarySelection?.session.key.id).toBe('b')
    expect(f.store.getSnapshot().listSelection).toBeNull()
  })
})

describe('session placement interactions', () => {
  function dragOverOrDrop(type: 'dragover' | 'drop', target: HTMLElement, dataTransfer: object) {
    const left =
      target.getAttribute('aria-label') === 'Drop in Left Pane' || target.dataset.pane === 'main'
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: left ? 600 : 800,
      clientY: 300
    })
    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
    fireEvent(target, event)
  }
  function startDrag(id: string) {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement
    ) {
      const left = this.getAttribute('data-drop-pane') === 'main'
      return new DOMRect(left ? 500 : 700, 0, 200, 600)
    })
    const row = screen.getByRole('option', { name: new RegExp(`Synthetic ${id},`) })
    const values = new Map<string, string>()
    const dataTransfer = {
      types: ['application/x-agentpeek-session'],
      effectAllowed: 'copy',
      dropEffect: 'copy',
      setData: (type: string, value: string) => values.set(type, value),
      getData: (type: string) => values.get(type) ?? ''
    }
    fireEvent.dragStart(row, { dataTransfer })
    return { row, dataTransfer }
  }

  it('previews without selection/read changes, drops in either pane and preserves sibling state', async () => {
    const f = mount()
    await choose('a')
    const original = screen.getByRole('region', { name: 'Recent messages' })
    const drag = startDrag('b')
    const right = screen.getByRole('region', { name: 'Drop in Right Pane' })
    const generation = f.store.getSnapshot().targetGeneration
    dragOverOrDrop('dragover', right, drag.dataTransfer)
    expect(f.store.getSnapshot().targetGeneration).toBe(generation)
    expect(f.store.getSnapshot().selection?.session.key.id).toBe('a')
    expect(f.store.getSnapshot().secondarySelection).toBeNull()
    dragOverOrDrop('drop', right, drag.dataTransfer)
    fireEvent.dragEnd(drag.row)
    await within(pane('Right')).findByRole('heading', { name: 'Synthetic b' })
    expect(messages('Left')).toBe(original)
    const sibling = messages('Right')
    await userEvent.click(within(pane('Right')).getByRole('button', { name: 'Show More' }))
    fireEvent.keyDown(sibling, { key: 'PageDown' })
    fireEvent.scroll(sibling, { target: { scrollTop: 87 } })
    const replacement = startDrag('c')
    dragOverOrDrop('drop', pane('Left'), replacement.dataTransfer)
    fireEvent.dragEnd(replacement.row)
    await within(pane('Left')).findByRole('heading', { name: 'Synthetic c' })
    expect(messages('Right')).toBe(sibling)
    expect(sibling.scrollTop).toBe(87)
    expect(within(pane('Right')).getByRole('button', { name: 'Collapse Message' })).toBeTruthy()
    expect(f.store.getSnapshot().activePane).toBe('main')
    await choose('d')
    expect(f.store.getSnapshot().selection?.session.key.id).toBe('d')
    fireEvent.pointerDown(pane('Right'))
    await choose('a')
    expect(f.store.getSnapshot().selection?.session.key.id).toBe('d')
    expect(f.store.getSnapshot().secondarySelection?.session.key.id).toBe('a')
    expect(screen.getAllByRole('option', { selected: true })).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Open in Second Pane' })).toBeNull()
  })

  it('clears the preview when live regrouping detaches the drag origin before cancellation', async () => {
    const f = mount()
    await choose('a')
    const drag = startDrag('b')
    act(() =>
      f.push(
        snapshot([session('a'), { ...unread('b'), activity: { state: 'idle' } }, session('c')])
      )
    )
    expect(drag.row.isConnected).toBe(false)
    expect(screen.getByRole('region', { name: 'Drop in Right Pane' })).toBeTruthy()
    fireEvent.dragEnd(drag.row)
    expect(screen.queryByRole('region', { name: 'Drop in Right Pane' })).toBeNull()
    await choose('c')
    expect(f.store.getSnapshot().selection?.session.key.id).toBe('c')
  })

  it('cancels with Escape or an outside drop without changing panes, and rejects stale source drops', async () => {
    const f = mount()
    await choose('a')
    await keepMain(f)
    const before = f.store.getSnapshot()
    const drag = startDrag('b')
    dragOverOrDrop(
      'dragover',
      screen.getByRole('region', { name: 'Drop in Left Pane' }),
      drag.dataTransfer
    )
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' })
    fireEvent.dragEnd(drag.row)
    expect(screen.queryByRole('region', { name: 'Drop in Left Pane' })).toBeNull()
    expect(f.store.getSnapshot().selection).toBe(before.selection)
    expect(f.store.getSnapshot().secondarySelection).toBe(before.secondarySelection)
    const outside = startDrag('c')
    fireEvent.drop(screen.getByRole('listbox'), { dataTransfer: outside.dataTransfer })
    fireEvent.dragEnd(outside.row)
    expect(f.store.getSnapshot().selection).toBe(before.selection)
    startDrag('b')
    act(() => f.push(snapshot([session('a'), session('c')])))
    expect(screen.queryByRole('region', { name: 'Drop in Right Pane' })).toBeNull()
    expect(f.store.getSnapshot().secondarySelection?.session.key.id).toBe('a')
    await choose('c')
    expect(f.store.getSnapshot().secondarySelection?.session.key.id).toBe('c')
  })
})
