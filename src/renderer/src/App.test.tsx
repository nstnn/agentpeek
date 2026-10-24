import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { App } from './App'
import { createSessionsStore } from './sessions-store'
import { fakeApi, NOW, session, snapshot } from '../test-support'
import type { Session, SessionActivity } from '../../core/session'

function mount(initial = snapshot()) {
  const fake = fakeApi(initial)
  Object.defineProperty(window, 'agentpeek', { value: fake.api, configurable: true })
  const store = createSessionsStore(fake.api)
  store.setGrouping('status')
  return { ...fake, store, ...render(<App store={store} />) }
}

describe('sessions interface', () => {
  it('waits for current target sync, ignores stale completion and keeps inactive Main updates unread', async () => {
    const unread = (id: string) =>
      session(id, {
        lastReply: {
          cursor: id,
          completedAt: NOW,
          isError: false,
          errorCode: null,
          newerTurnStarted: false
        },
        attention: { waiting: false, error: false, newReply: true }
      })
    const a = unread('a')
    const b = unread('b')
    const f = mount(snapshot([a, b]))
    await screen.findByRole('option', { name: /Synthetic a/ })
    fireEvent(window, new Event('focus'))
    const pending: (() => void)[] = []
    f.api.setSelection.mockImplementation(
      () => new Promise<void>((resolve) => pending.push(resolve))
    )
    await userEvent.click(screen.getByRole('option', { name: /Synthetic a/ }))
    await screen.findByText('No recent messages.')
    expect(f.api.markRead).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('option', { name: /Synthetic b/ }))
    await screen.findByText('No recent messages.')
    await act(async () => {
      pending[0]!()
      await Promise.resolve()
    })
    expect(f.api.markRead).not.toHaveBeenCalled()
    await act(async () => {
      pending[1]!()
      await Promise.resolve()
    })
    expect(f.api.markRead.mock.calls).toEqual([[b.key, 'b']])
    f.api.markRead.mockClear()
    f.api.getMessages.mockClear()
    act(() => f.command({ type: 'open-secondary', key: a.key }))
    await act(async () => {
      pending.at(-1)!()
      await Promise.resolve()
    })
    act(() => f.push(snapshot([a, { ...b, lastReply: { ...b.lastReply!, cursor: 'b-new' } }])))
    await within(screen.getByRole('complementary', { name: 'Right pane' })).findByText(
      'No recent messages.'
    )
    expect(f.api.markRead.mock.calls).toEqual([[a.key, 'a']])
    expect(f.api.getMessages.mock.calls.map(([key]) => key.id)).toEqual(['a', 'b'])
  })
  it.each(['insert', 'remove'])(
    'anchors the selected row when an earlier group is %s-ed',
    async (mode) => {
      const a = session('anchor')
      const idle = session('other', { activity: { state: 'idle' } })
      const error = { ...idle, attention: { waiting: false, error: true, newReply: false } }
      const fake = mount(snapshot([a, mode === 'remove' ? error : idle]))
      const row = await screen.findByRole('option', { name: /Synthetic anchor/ })
      const list = screen.getByRole('listbox')
      const head = list.firstElementChild as HTMLElement
      const tail = list.lastElementChild as HTMLElement
      const height = (e: HTMLElement) => parseFloat(e.style.height) || 0
      const preceding = () => (document.getElementById('session-codex:other') ? 80 : 0)
      let scroll = 0
      Object.defineProperty(list, 'clientHeight', { value: 500 })
      Object.defineProperty(list, 'scrollHeight', {
        get: () => Math.max(500, 80 + preceding() + height(head) + height(tail))
      })
      Object.defineProperty(list, 'scrollTop', {
        get: () => scroll,
        set: (value: number) => {
          scroll = Math.max(0, Math.min(value, list.scrollHeight - list.clientHeight))
        }
      })
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
        this: HTMLElement
      ) {
        const top =
          this === row
            ? 20 + preceding() + height(head) - scroll
            : this === tail
              ? 80 + preceding() + height(head) - scroll
              : 0
        return new DOMRect(0, top, 400, 40)
      })
      await userEvent.click(row)
      const before = row.getBoundingClientRect().top
      act(() => fake.push(snapshot([a, mode === 'insert' ? error : idle])))
      expect(row.getBoundingClientRect().top).toBe(before)
      expect(document.activeElement).toBe(list)
      expect(row.getAttribute('aria-selected')).toBe('true')
      expect(
        screen.getByRole('button', {
          name:
            mode === 'insert'
              ? 'Active, 1 session needs attention'
              : 'Active, 0 sessions need attention'
        })
      ).toBeTruthy()
    }
  )
  it('shows the launch read, then connected sources, live groups and the count-once badge', async () => {
    const waiting = session('waiting', {
      key: { tool: 'claude', id: 'waiting' },
      activity: { state: 'waiting', waitingFor: 'permission prompt' },
      attention: { waiting: true, newReply: true, error: true }
    })
    const fake = mount(snapshot([session('running'), waiting]))
    expect(screen.getByText('Reading sessions…')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /source: Connected/ })).toBeNull()
    await screen.findByRole('option', { name: /Synthetic waiting/ })
    expect(screen.getAllByRole('group').map((g) => g.getAttribute('aria-labelledby'))).toEqual([
      'group-waiting',
      'group-running'
    ])
    expect(screen.getByRole('button', { name: 'Active, 1 session needs attention' })).toBeTruthy()
    expect(screen.getByRole('listbox').getAttribute('aria-activedescendant')).toBeNull()
    expect(fake.api.markRead).not.toHaveBeenCalled()
    expect(screen.getByText(/Fixture data/).textContent).toContain('/synthetic/home')
  })

  it('filters every view, uses live per-view counts, and routes native View commands', async () => {
    const fake = mount(
      snapshot([
        session('a'),
        session('b', { key: { tool: 'claude', id: 'b' }, pinned: true }),
        session('idle', { activity: { state: 'idle' } })
      ])
    )
    await screen.findByRole('option', { name: /Synthetic a/ })
    const user = userEvent.setup()
    await user.click(screen.getByRole('radio', { name: 'Claude Code 1' }))
    expect(screen.getAllByRole('option')).toHaveLength(1)
    act(() => fake.command('view:pinned'))
    expect(screen.getByRole('heading', { name: 'Pinned', level: 1 })).toBeTruthy()
    expect(screen.getByRole('radio', { name: 'All 1' })).toBeTruthy()
    act(() => fake.command('view:all'))
    expect(screen.getByRole('radio', { name: 'All 3' })).toBeTruthy()
    expect(screen.getAllByRole('option')).toHaveLength(1)
    expect(screen.getByText(/Sessions active in the last 7 days/)).toBeTruthy()
    expect(fake.api.setSelection).toHaveBeenLastCalledWith(null, { secondPaneOpen: false })
  })

  it('keeps a selected row, focus, scroll and group when it becomes idle or disappears', async () => {
    const a = session('a')
    const b = session('b')
    const fake = mount(snapshot([a, b]))
    const row = await screen.findByRole('option', { name: /Synthetic a/ })
    await userEvent.click(row)
    const list = screen.getByRole('listbox')
    list.scrollTop = 37
    act(() => fake.push(snapshot([{ ...a, activity: { state: 'idle' } }, b])))
    expect(
      screen.getByRole('option', { name: /Synthetic a.*Idle/ }).getAttribute('aria-selected')
    ).toBe('true')
    expect(within(screen.getByRole('group')).getAllByRole('option')[0]?.textContent).toContain(
      'Synthetic a'
    )
    expect(document.activeElement).toBe(list)
    expect(list.scrollTop).toBe(37)
    act(() => fake.push(snapshot([b])))
    expect(screen.getByRole('option', { name: /Synthetic a/ })).toBeTruthy()
    await userEvent.click(screen.getByRole('option', { name: /Synthetic b/ }))
    expect(screen.queryByRole('option', { name: /Synthetic a/ })).toBeNull()
    expect(fake.api.markRead).not.toHaveBeenCalled()
  })

  it('supports arrow selection, sidebar and tool keyboard navigation without extra tab stops', async () => {
    const fake = mount(snapshot([session('a'), session('b')]))
    await screen.findByRole('option', { name: /Synthetic a/ })
    const list = screen.getByRole('listbox')
    list.focus()
    await userEvent.keyboard('{ArrowDown}{ArrowDown}')
    expect(fake.api.setSelection).toHaveBeenLastCalledWith(
      { tool: 'codex', id: 'b' },
      { secondPaneOpen: false }
    )
    screen.getByRole('button', { name: 'Active, 0 sessions need attention' }).focus()
    await userEvent.keyboard('{ArrowDown}')
    expect(screen.getByRole('heading', { name: 'Pinned', level: 1 })).toBeTruthy()
    expect(document.activeElement?.textContent).toContain('Pinned')
    screen.getByRole('radio', { name: 'All 0' }).focus()
    await userEvent.keyboard('{ArrowRight}')
    expect(document.activeElement?.getAttribute('aria-checked')).toBe('true')
    expect(document.activeElement?.textContent).toContain('Codex')
  })

  it('uses exact session keys for context menus, keeps gray highlight until dismissal, supports keyboard', async () => {
    const fake = mount(snapshot([session('a'), session('b')]))
    let dismiss!: () => void
    fake.api.showSessionMenu.mockImplementation((key) => {
      // Native popup entry can suspend painting before React's event batch commits.
      expect(
        document.getElementById(`session-${key.tool}:${key.id}`)?.classList.contains('context-open')
      ).toBe(true)
      return new Promise((resolve) => {
        dismiss = resolve
      })
    })
    const primary = await screen.findByRole('option', { name: /Synthetic a/ })
    const row = screen.getByRole('option', { name: /Synthetic b/ })
    fireEvent.contextMenu(row)
    expect(fake.store.getSnapshot().selection).toBeNull()
    expect(fake.api.getMessages).not.toHaveBeenCalled()
    await act(async () => {
      dismiss()
      await Promise.resolve()
    })
    await userEvent.click(primary)
    await screen.findByText('No recent messages.')
    const selection = fake.store.getSnapshot().selection
    fake.api.setSelection.mockClear()
    fake.api.getMessages.mockClear()
    fireEvent.contextMenu(row)
    expect(fake.api.showSessionMenu).toHaveBeenLastCalledWith({ tool: 'codex', id: 'b' })
    expect(row.classList.contains('context-open')).toBe(true)
    expect(row.getAttribute('aria-selected')).toBe('false')
    expect(primary.getAttribute('aria-selected')).toBe('true')
    expect(fake.store.getSnapshot().selection).toBe(selection)
    expect(screen.getByRole('heading', { name: 'Synthetic a' })).toBeTruthy()
    expect(fake.api.getMessages).not.toHaveBeenCalled()
    expect(fake.api.setSelection).not.toHaveBeenCalled()
    await act(async () => {
      dismiss()
      await Promise.resolve()
    })
    expect(row.classList.contains('context-open')).toBe(false)
    expect(fake.store.getSnapshot().selection).toBe(selection)
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'F10', shiftKey: true })
    expect(fake.api.showSessionMenu).toHaveBeenCalledTimes(3)
    expect(fake.api.showSessionMenu).toHaveBeenLastCalledWith({ tool: 'codex', id: 'a' })
    await act(async () => {
      dismiss()
      await Promise.resolve()
    })
  })

  it('dismisses the first-launch strip for the run and unsubscribes on unmount', async () => {
    const fake = mount(snapshot([], { firstLaunch: true }))
    await userEvent.click(
      await screen.findByRole('button', { name: 'Dismiss first launch notice' })
    )
    act(() => fake.push(snapshot([], { firstLaunch: true })))
    expect(screen.queryByText(/First launch:/)).toBeNull()
    fake.unmount()
    expect(fake.offSnapshot).toHaveBeenCalledOnce()
    expect(fake.offCommand).toHaveBeenCalledTimes(2)
  })

  it('presents two details and replacement navigation in the middle split band', async () => {
    const a = session('a')
    const b = session('b')
    const f = mount(snapshot([a, b]))
    await userEvent.click(await screen.findByRole('option', { name: /Synthetic a/ }))
    await screen.findByText('No recent messages.')
    f.api.getMessages.mockClear()
    act(() => f.store.openSecondary(b.key))
    expect(screen.getAllByRole('complementary', { name: 'Left pane' })).toHaveLength(1)
    expect(screen.getByRole('heading', { name: 'Synthetic a' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Synthetic b' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Open in Second Pane' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Close Right Pane' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Show Sessions' })).toBeTruthy()
    expect(screen.queryByRole('listbox')).toBeNull()
    await vi.waitFor(() => expect(f.api.getMessages).toHaveBeenCalledWith(b.key, 20))
  })

  it.each([
    ['running', { state: 'running' }, {}, 'Running'],
    [
      'permission',
      { state: 'waiting', waitingFor: 'permission prompt' },
      {},
      'Waiting for you · Permission'
    ],
    [
      'question',
      { state: 'waiting', waitingFor: 'input needed' },
      {},
      'Waiting for you · Question'
    ],
    ['dialog', { state: 'waiting', waitingFor: 'dialog open' }, {}, 'Waiting for you · Dialog'],
    [
      'sandbox',
      { state: 'waiting', waitingFor: 'sandbox request' },
      {},
      'Waiting for you · Sandbox'
    ],
    ['worker', { state: 'waiting', waitingFor: 'worker request' }, {}, 'Waiting for you · Worker'],
    ['goal', { state: 'waiting', waitingFor: 'goal proposal' }, {}, 'Waiting for you · Goal'],
    ['other', { state: 'waiting', waitingFor: 'future value' }, {}, 'Waiting for you'],
    [
      'reply',
      { state: 'idle' },
      { attention: { waiting: false, error: false, newReply: true } },
      'New reply'
    ],
    [
      'error',
      { state: 'idle' },
      {
        attention: { waiting: false, error: true, newReply: false },
        lastReply: {
          cursor: 'x',
          completedAt: NOW,
          isError: true,
          errorCode: 'server_overloaded',
          newerTurnStarted: false
        }
      },
      'Error · Server overloaded'
    ],
    ['ended', { state: 'unknown', reason: 'process-ended' }, {}, 'Unknown · Process ended'],
    ['quiet', { state: 'unknown', reason: 'quiet' }, {}, 'Unknown · Quiet for 30 min'],
    ['app', { state: 'unknown', reason: 'app-not-running' }, {}, 'Unknown · Codex not running'],
    ['unreadable', { state: 'unknown', reason: 'unreadable' }, {}, "Unknown · Can't read"],
    [
      'unsupported',
      { state: 'unknown', reason: 'unsupported' },
      {},
      'Unknown · Unsupported format'
    ],
    ['idle', { state: 'idle' }, {}, 'Idle']
  ] as [string, SessionActivity, Partial<Session>, string][])(
    'renders %s as labeled text in an accessible option',
    async (_name, activity, change, label) => {
      const fake = mount(snapshot([session('test', { activity, ...change })]))
      act(() => fake.command('view:all'))
      expect((await screen.findByRole('option')).getAttribute('aria-label')).toContain(label)
    }
  )
})
