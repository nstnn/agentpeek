import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { App } from './App'
import { createSessionsStore } from './sessions-store'
import { fakeApi, NOW, session, snapshot } from '../test-support'

function mount() {
  const a = session('a')
  const b = session('b')
  const fake = fakeApi(snapshot([a, b]))
  Object.defineProperty(window, 'agentpeek', { value: fake.api, configurable: true })
  const store = createSessionsStore(fake.api)
  store.setGrouping('status')
  return { ...fake, store, a, b, ...render(<App store={store} />) }
}

describe('Settings', () => {
  it('opens from the sidebar and native command, changes theme and keeps the rail entry reachable', async () => {
    const f = mount()
    await screen.findByRole('option', { name: /Synthetic a/ })
    await userEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy()
    await waitFor(() =>
      expect(screen.getByRole<HTMLInputElement>('radio', { name: 'System' }).checked).toBe(true)
    )
    await userEvent.click(screen.getByRole('radio', { name: 'Dark' }))
    expect(f.api.setTheme).toHaveBeenCalledWith('dark')
    await userEvent.click(screen.getByRole('button', { name: 'Close Settings' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Collapse Views' }))
    expect(screen.getByRole('button', { name: 'Settings' })).toBeTruthy()
    act(() => f.command('settings'))
    await screen.findByRole('dialog', { name: 'Settings' })
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { bubbles: true, cancelable: true }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
  it('retains both selections and suppresses transcript requests and acknowledgements under Settings', async () => {
    const f = mount()
    await screen.findByRole('option', { name: /Synthetic a/ })
    fireEvent(window, new Event('focus'))
    await userEvent.click(screen.getByRole('option', { name: /Synthetic a/ }))
    act(() => f.command({ type: 'open-secondary', key: f.b.key }))
    await screen.findAllByText('No recent messages.')
    const before = f.store.getSnapshot()
    await userEvent.click(screen.getByRole('button', { name: 'Settings' }))
    await screen.findByRole('radio', { name: 'System' })
    f.api.getMessages.mockClear()
    f.api.markRead.mockClear()
    const unread = {
      ...f.b,
      attention: { waiting: false, error: false, newReply: true },
      lastReply: {
        cursor: 'behind-settings',
        completedAt: NOW,
        isError: false,
        errorCode: null,
        newerTurnStarted: false
      }
    }
    act(() => {
      f.push(snapshot([f.a, unread]))
      f.command('view:all')
      f.command({ type: 'close-secondary' })
    })
    expect(f.api.getMessages).not.toHaveBeenCalled()
    expect(f.api.markRead).not.toHaveBeenCalled()
    expect(f.store.getSnapshot().view).toBe(before.view)
    expect(f.store.getSnapshot().secondarySelection?.session.key).toEqual(f.b.key)
    expect(f.api.setSelection).toHaveBeenLastCalledWith(null, { secondPaneOpen: false })
    await userEvent.click(screen.getByRole('button', { name: 'Close Settings' }))
    await waitFor(() => expect(f.api.markRead).toHaveBeenCalledWith(f.b.key, 'behind-settings'))
    expect(f.store.getSnapshot().selection?.session.key).toEqual(f.a.key)
  })
  it('keeps switches in Settings, shows an off-source placeholder and restores reading after enabling', async () => {
    const f = mount()
    await userEvent.click(await screen.findByRole('option', { name: /Synthetic a/ }))
    await screen.findByText('No recent messages.')
    expect(screen.queryByRole('switch')).toBeNull()
    f.api.setSourceEnabled.mockImplementation((tool, enabled) => {
      expect(tool).toBe('codex')
      f.push(
        snapshot(enabled ? [f.a, f.b] : [], {
          health: {
            codex: enabled ? { state: 'connected', lastReadAt: NOW } : { state: 'off' },
            claude: { state: 'not-installed' },
            antigravity: { state: 'not-installed' }
          }
        })
      )
      return Promise.resolve()
    })
    await userEvent.click(screen.getByRole('button', { name: 'Settings' }))
    const toggle = screen.getByRole('switch', { name: 'Monitor Codex' })
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    f.api.setSourceEnabled.mockRejectedValueOnce(new Error('Synthetic failure'))
    await userEvent.click(toggle)
    await screen.findByText(/Couldn't update Codex monitoring/)
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    await userEvent.click(toggle)
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'))
    await userEvent.click(screen.getByRole('button', { name: 'Close Settings' }))
    expect(screen.getByRole('heading', { name: 'Codex monitoring is off' })).toBeTruthy()
    expect(screen.queryByText('No recent messages.')).toBeNull()
    expect(screen.queryByRole('option', { name: /Synthetic a/ })).toBeNull()
    expect(f.store.getSnapshot().listSelection).toBeNull()
    expect(screen.queryByRole('img', { name: 'Codex source: Connected' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Settings' }))
    await userEvent.click(screen.getByRole('switch', { name: 'Monitor Codex' }))
    await userEvent.click(screen.getByRole('button', { name: 'Close Settings' }))
    await screen.findByText('No recent messages.')
    expect(f.store.getSnapshot().selection?.session.key).toEqual(f.a.key)
  })
  it('keeps a missing tool enabled and exposes Settings when all monitoring is off', async () => {
    const f = mount()
    await userEvent.click(await screen.findByRole('option', { name: /Synthetic a/ }))
    act(() =>
      f.push(
        snapshot([], {
          health: {
            codex: { state: 'off' },
            claude: { state: 'off' },
            antigravity: { state: 'off' }
          }
        })
      )
    )
    const list = within(screen.getByRole('main', { name: 'Sessions' }))
    expect(list.getByRole('heading', { name: 'Monitoring is off' })).toBeTruthy()
    await userEvent.click(list.getByRole('button', { name: 'Open Settings' }))
    expect(screen.getByRole('switch', { name: 'Monitor Codex' }).getAttribute('aria-checked')).toBe(
      'false'
    )
    act(() =>
      f.push(
        snapshot([], {
          health: {
            codex: { state: 'off' },
            claude: { state: 'not-installed' },
            antigravity: { state: 'connected', lastReadAt: NOW }
          }
        })
      )
    )
    expect(
      screen.getByRole('switch', { name: 'Monitor Claude Code' }).getAttribute('aria-checked')
    ).toBe('true')
    expect(screen.getByText('Not installed')).toBeTruthy()
    // The third source has its own switch, never another tool's label.
    expect(
      screen.getByRole('switch', { name: 'Monitor Antigravity' }).getAttribute('aria-checked')
    ).toBe('true')
    expect(screen.getAllByRole('switch', { name: /^Monitor / })).toHaveLength(3)
  })
  it('restores the selection on save failure and can load settings again after a failed read', async () => {
    const f = mount()
    f.api.getTheme.mockRejectedValueOnce(new Error('Synthetic error'))
    await userEvent.click(screen.getByRole('button', { name: 'Settings' }))
    await screen.findByText("Couldn't load appearance settings.")
    await userEvent.click(screen.getByRole('button', { name: 'Try Again' }))
    await waitFor(() =>
      expect(screen.getByRole<HTMLInputElement>('radio', { name: 'System' }).checked).toBe(true)
    )
    f.api.setTheme.mockRejectedValueOnce(new Error('Synthetic error'))
    await userEvent.click(screen.getByRole('radio', { name: 'Dark' }))
    await screen.findByText(/Couldn't save theme/)
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'System' }).checked).toBe(true)
    await userEvent.click(screen.getByRole('radio', { name: 'Dark' }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Dark' }).checked).toBe(true)
  })
})
