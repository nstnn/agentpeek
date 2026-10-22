import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useSyncExternalStore } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { sessionKeyToString, type RecentMessages } from '../../core/session'
import { fakeApi, NOW, session, snapshot } from '../test-support'
import { App } from './App'
import { createSessionsStore, displayedGroups, sameKey, type SessionsStore } from './sessions-store'
import { SessionDetail } from './SessionDetail'
import type { AgentPeekApi } from '../../shared/api'
import { rowStatus } from './session-display'

function mount(initial = snapshot()) {
  const fake = fakeApi(initial)
  Object.defineProperty(window, 'agentpeek', { value: fake.api, configurable: true })
  const store = createSessionsStore(fake.api)
  store.setGrouping('status')
  return { ...fake, store, ...render(<App store={store} />) }
}

const failed = session('error', {
  activity: { state: 'idle' },
  attention: { waiting: false, error: true, newReply: false },
  lastReply: {
    cursor: 'terminal',
    completedAt: NOW,
    isError: true,
    errorCode: 'rate_limit',
    newerTurnStarted: false
  }
})
const other = session('other', { key: { tool: 'claude', id: 'other' } })
const denied = snapshot([other], {
  takenAt: NOW + 60_000,
  health: {
    codex: { state: 'no-access', lastReadAt: NOW },
    claude: { state: 'connected', lastReadAt: NOW }
  }
})

describe('truthful status and recovery transitions', () => {
  it.each([true, false])(
    'acknowledges error=%s once while retaining slot, scroll and outcome',
    async (isError) => {
      const unread = {
        ...failed,
        attention: { waiting: false, error: isError, newReply: !isError },
        lastReply: { ...failed.lastReply!, isError }
      }
      const read = { ...unread, attention: { waiting: false, error: false, newReply: false } }
      const f = mount(snapshot([unread, other]))
      f.api.markRead.mockImplementation(() => {
        f.push(snapshot([read, other]))
        return Promise.resolve(true)
      })
      fireEvent.focus(window)
      const row = await screen.findByRole('option', { name: /Synthetic error/ })
      const list = screen.getByRole('listbox')
      list.scrollTop = 37
      await userEvent.click(row)
      await vi.waitFor(() => expect(f.api.markRead).toHaveBeenCalledTimes(1))
      expect(row.getAttribute('aria-label')).toContain(isError ? 'Error · Read' : 'Idle')
      expect(row.getAttribute('aria-label')).toContain('kept here while selected')
      expect(row.closest('[role=group]')?.textContent).toContain('0 outstanding')
      expect(list.scrollTop).toBe(37)
      expect(document.activeElement).toBe(list)
      const next = {
        ...read,
        activity: { state: 'running' } as const,
        lastReply: { ...read.lastReply, newerTurnStarted: true }
      }
      act(() => f.push(snapshot([next, other])))
      expect(row.getAttribute('aria-label')).toContain('Running')
      expect(row.getAttribute('aria-label')).not.toContain('Read')
      expect(f.api.markRead).toHaveBeenCalledTimes(1)
      await userEvent.click(screen.getByRole('option', { name: /Synthetic other/ }))
      expect(screen.queryByText('Kept here while selected.')).toBeNull()
    }
  )

  it('keeps Waiting semantics ahead of acknowledged error outcomes', () => {
    expect(
      rowStatus({
        ...failed,
        activity: { state: 'waiting', waitingFor: 'permission prompt' },
        attention: { waiting: true, error: false, newReply: false }
      }).label
    ).toBe('Waiting for you · Permission')
  })

  it('freezes observation time across absent snapshots and ignores late transcript results', async () => {
    const f = mount(snapshot([failed, other]))
    let finish!: (value: RecentMessages) => void
    f.api.getMessages.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    await userEvent.click(await screen.findByRole('option', { name: /Synthetic error/ }))
    const lastSeen = screen.getByText(/Last seen in AgentPeek:/).textContent
    act(() => f.push(denied))
    act(() => f.push({ ...denied, takenAt: NOW + 600_000 }))
    expect(screen.getByText(/Last seen in AgentPeek:/).textContent).toBe(lastSeen)
    expect(screen.getByRole('option', { name: /Unavailable — last known: Error/ })).toBeTruthy()
    const detail = screen.getByRole('complementary', { name: 'Session detail' })
    for (const name of ['Open Codex', 'Mark Read', 'Pin', 'Copy Session ID'])
      expect(within(detail).getByRole('button', { name }).hasAttribute('disabled')).toBe(true)
    await act(async () => {
      finish({
        kind: 'messages',
        hasOlder: false,
        messages: [{ kind: 'reply', text: 'Stale synthetic result', at: NOW }]
      })
      await Promise.resolve()
    })
    expect(screen.queryByText('Stale synthetic result')).toBeNull()
    expect(f.api.markRead).not.toHaveBeenCalled()
    expect(within(detail).queryByRole('button', { name: 'Try Again' })).toBeNull()
  })

  it('deduplicates reload, keeps still-denied membership missing, and recovers through snapshots', async () => {
    const f = mount(snapshot([failed, other]))
    await userEvent.click(await screen.findByRole('option', { name: /Synthetic error/ }))
    act(() => f.push(denied))
    let finish!: () => void
    f.api.reload.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const detail = screen.getByRole('complementary', { name: 'Session detail' })
    const reload = within(detail).getByRole('button', { name: 'Reload Sessions' })
    await userEvent.click(reload)
    fireEvent.click(reload)
    expect(f.api.reload).toHaveBeenCalledTimes(1)
    expect(reload.getAttribute('aria-disabled')).toBe('true')
    expect(document.activeElement).toBe(reload)
    await act(async () => {
      finish()
      await Promise.resolve()
    })
    expect(within(detail).getByText(/Unavailable — last known:/)).toBeTruthy()
    expect(document.activeElement).toBe(reload)
    f.api.reload.mockResolvedValueOnce()
    await userEvent.click(reload)
    // Service snapshots can follow the completed IPC request rather than precede it.
    act(() => f.push(snapshot([failed, other], { takenAt: NOW + 900_000 })))
    await screen.findByText('No recent messages.')
    expect(screen.queryByText(/Unavailable — last known:/)).toBeNull()
    expect(screen.getByText(/Last seen in AgentPeek:/).textContent).toContain(
      new Date(NOW + 900_000).toLocaleString('en-US', { hour12: false })
    )
    await vi.waitFor(() =>
      expect([
        screen.getByRole('region', { name: 'Recent messages' }),
        screen.getByRole('listbox')
      ]).toContain(document.activeElement)
    )
  })

  it('reports rejected reload without exposing raw errors and leaves the healthy source usable', async () => {
    const f = mount(snapshot([failed, other]))
    await userEvent.click(await screen.findByRole('option', { name: /Synthetic error/ }))
    act(() => f.push(denied))
    f.api.reload.mockRejectedValueOnce(new Error('Synthetic private path'))
    await userEvent.click(screen.getAllByRole('button', { name: 'Reload Sessions' })[0]!)
    expect(await screen.findByText(/Couldn't reload sessions/)).toBeTruthy()
    expect(screen.queryByText('Synthetic private path')).toBeNull()
    await userEvent.click(screen.getByRole('option', { name: /Synthetic other/ }))
    expect(screen.getByRole('heading', { name: 'Synthetic other' })).toBeTruthy()
    expect(screen.queryByRole('option', { name: /Synthetic error/ })).toBeNull()
  })

  it('requires a fresh successful transcript read after rediscovery before acknowledging', async () => {
    const f = mount(snapshot([failed, other]))
    await userEvent.click(await screen.findByRole('option', { name: /Synthetic error/ }))
    await screen.findByText('No recent messages.')
    act(() => f.push(denied))
    let finish!: (value: RecentMessages) => void
    f.api.getMessages.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    fireEvent.focus(window)
    act(() => f.push(snapshot([failed, other])))
    expect(screen.getByText('Loading messages…')).toBeTruthy()
    expect(f.api.markRead).not.toHaveBeenCalled()
    await act(async () => {
      finish({ kind: 'unreadable' })
      await Promise.resolve()
    })
    expect(f.api.markRead).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Try Again' }))
    await vi.waitFor(() => expect(f.api.markRead).toHaveBeenCalledOnce())
    expect(document.activeElement).toBe(screen.getByRole('region', { name: 'Recent messages' }))
  })

  it('does not replace a new selection when reload and a former transcript finish late', async () => {
    const f = mount(snapshot([failed, other]))
    await userEvent.click(await screen.findByRole('option', { name: /Synthetic error/ }))
    act(() => f.push(denied))
    let finish!: () => void
    f.api.reload.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    await userEvent.click(screen.getAllByRole('button', { name: 'Reload Sessions' })[0]!)
    await userEvent.click(screen.getByRole('option', { name: /Synthetic other/ }))
    await act(async () => {
      f.push(snapshot([failed, other]))
      finish()
      await Promise.resolve()
    })
    expect(screen.getByRole('heading', { name: 'Synthetic other' })).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('listbox'))
  })

  it('routes a known missing transcript to discovery reload', async () => {
    const f = mount(snapshot([failed, other]))
    f.api.getMessages.mockResolvedValue({ kind: 'not-found' })
    await userEvent.click(await screen.findByRole('option', { name: /Synthetic error/ }))
    const detail = screen.getByRole('complementary', { name: 'Session detail' })
    await userEvent.click(await within(detail).findByRole('button', { name: 'Reload Sessions' }))
    expect(f.api.reload).toHaveBeenCalledOnce()
    expect(within(detail).queryByRole('button', { name: 'Try Again' })).toBeNull()
  })
})

describe('reload bounds and observation provenance', () => {
  it('bounds a hanging reload and ignores its late completion during the next attempt', async () => {
    vi.useFakeTimers()
    try {
      const f = fakeApi()
      let late!: () => void
      f.api.reload.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            late = resolve
          })
      )
      const store = createSessionsStore(f.api)
      store.setGrouping('status')
      const first = store.reload()
      await vi.advanceTimersByTimeAsync(10_000)
      await first
      expect(store.getSnapshot().reloadPending).toBe(false)
      expect(store.getSnapshot().reloadError).toContain("Couldn't reload")
      let finish!: () => void
      f.api.reload.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve
          })
      )
      const second = store.reload()
      late()
      await Promise.resolve()
      expect(store.getSnapshot().reloadPending).toBe(true)
      expect(store.getSnapshot().reloadVersion).toBe(0)
      finish()
      await second
      expect(store.getSnapshot().reloadVersion).toBe(1)
      expect(store.getSnapshot().reloadError).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('never fabricates a last-seen time from an unobserved row or its activity time', () => {
    const store = createSessionsStore(fakeApi().api)
    store.setGrouping('status')
    store.select(failed, [{ id: 'errors', label: 'Errors', sessions: [failed] }])
    expect(store.getSnapshot().selection?.lastSeenAt).toBeNull()
    expect(displayedGroups(store.getSnapshot())[0]?.sessions[0]).toBe(failed)
  })
})

// Exercise the store-to-detail contract without exposing unfinished split controls in App.
function SecondaryDetail({ store, api }: { store: SessionsStore; api: AgentPeekApi }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const selected = state.secondarySelection
  return selected ? (
    <SessionDetail
      key={`second:${sessionKeyToString(selected.session.key)}`}
      session={selected.session}
      api={api}
      visible={true}
      focused={false}
      canAutoRead={() => false}
      missing={!state.snapshot?.sessions.some((s) => sameKey(s.key, selected.session.key))}
      lastSeenAt={selected.lastSeenAt}
      sourceEpoch={selected.sourceEpoch}
      reloadPending={state.reloadPending}
      reloadVersion={state.reloadVersion}
      onReload={store.reload}
    />
  ) : null
}

describe('secondary selection detail contract', () => {
  it('discards a former secondary transcript after source loss and replacement', async () => {
    const a = session('main')
    const b = session('former-second')
    const c = session('replacement-second')
    const f = fakeApi(snapshot([a, b, c]))
    let finish!: (value: RecentMessages) => void
    f.api.getMessages.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const store = createSessionsStore(f.api)
    store.setGrouping('status')
    render(<SecondaryDetail store={store} api={f.api} />)
    await act(async () => Promise.resolve())
    act(() => {
      store.select(a, displayedGroups(store.getSnapshot()))
      store.openSecondary(b.key)
    })
    expect(screen.getByText('Loading messages…')).toBeTruthy()
    act(() => f.push(snapshot([a, c], { takenAt: NOW + 1 })))
    expect(screen.getByText(/Unavailable — last known:/)).toBeTruthy()
    act(() => store.openSecondary(c.key))
    await screen.findByText('No recent messages.')
    await act(async () => {
      finish({
        kind: 'messages',
        hasOlder: false,
        messages: [{ kind: 'reply', text: 'Former secondary synthetic result', at: NOW }]
      })
      await Promise.resolve()
    })
    expect(screen.queryByText('Former secondary synthetic result')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Synthetic replacement-second' })).toBeTruthy()
    expect(store.getSnapshot().selection?.session.key).toEqual(a.key)
    expect(store.getSnapshot().secondarySelection?.session.key).toEqual(c.key)
    expect(f.api.markRead).not.toHaveBeenCalled()
    act(() => store.closeSecondary())
    expect(screen.queryByRole('heading')).toBeNull()
  })
})
