import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { App } from './App'
import { createSessionsStore } from './sessions-store'
import { fakeApi, NOW, session, snapshot } from '../test-support'

// jsdom cannot supply native modal focus/inertness; those need the built app.
Object.defineProperties(HTMLDialogElement.prototype, {
  showModal: {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.setAttribute('open', '')
    }
  },
  close: {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.removeAttribute('open')
    }
  }
})

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
