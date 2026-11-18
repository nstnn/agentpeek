import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { SessionRangeStatus } from '../../core/snapshot'
import { App } from './App'
import { createSessionsStore } from './sessions-store'
import { fakeApi, session, snapshot } from '../test-support'

const SAVED: SessionRangeStatus = {
  savedDays: 7,
  savedMaxPerTool: 50,
  loadedDays: 7,
  loadedMaxPerTool: 50,
  olderAvailable: false
}

function mount(range: Partial<SessionRangeStatus> = {}) {
  const sessions = [session('a', { activity: { state: 'idle' } })]
  const fake = fakeApi(snapshot(sessions, { range: { ...SAVED, ...range } }))
  Object.defineProperty(window, 'agentpeek', { value: fake.api, configurable: true })
  const store = createSessionsStore(fake.api)
  store.setGrouping('status')
  render(<App store={store} />)
  const push = (next: Partial<SessionRangeStatus>) =>
    act(() => fake.push(snapshot(sessions, { range: { ...SAVED, ...next } })))
  return { ...fake, push }
}

describe('session range', () => {
  it('names the loaded range in All Sessions and offers Load Older only while older ones exist', async () => {
    const f = mount()
    act(() => f.command('view:all'))
    await screen.findByRole('option', { name: /Synthetic a/ })
    expect(
      screen.getByText(/Sessions active in the last 7 days \(up to 50 per tool\)/)
    ).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Load Older Sessions' })).toBeNull()

    f.push({ olderAvailable: true })
    let finish!: () => void
    f.api.loadOlderSessions.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    await userEvent.click(screen.getByRole('button', { name: 'Load Older Sessions' }))
    expect(f.api.loadOlderSessions).toHaveBeenCalledOnce()
    const pending = screen.getByRole('button', { name: 'Loading…' })
    expect(pending.getAttribute('aria-disabled')).toBe('true')
    await userEvent.click(pending)
    expect(f.api.loadOlderSessions).toHaveBeenCalledOnce()
    await act(async () => {
      finish()
      await Promise.resolve()
    })
    f.push({ loadedDays: 14, loadedMaxPerTool: 100, olderAvailable: false })
    expect(
      screen.getByText(
        /Sessions active in the last 14 days \(up to 100 per tool\).*stay loaded until you quit/
      )
    ).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Load Older|Loading/ })).toBeNull()
  })

  it('reports a failed Load Older and lets the user try again', async () => {
    const f = mount({ olderAvailable: true })
    act(() => f.command('view:all'))
    f.api.loadOlderSessions.mockRejectedValueOnce(new Error('synthetic'))
    await userEvent.click(await screen.findByRole('button', { name: 'Load Older Sessions' }))
    expect((await screen.findByRole('alert')).textContent).toBe(
      "Couldn't load older sessions. Try again."
    )
    await userEvent.click(screen.getByRole('button', { name: 'Load Older Sessions' }))
    expect(f.api.loadOlderSessions).toHaveBeenCalledTimes(2)
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it('shows the saved range in Settings and saves each change', async () => {
    const f = mount({ savedDays: 30, loadedDays: 60, loadedMaxPerTool: 100 })
    act(() => f.command('settings'))
    const dialog = await screen.findByRole('dialog', { name: 'Settings' })
    const days = within(dialog).getByRole<HTMLSelectElement>('combobox', {
      name: 'Show sessions active in the last'
    })
    const count = within(dialog).getByRole<HTMLSelectElement>('combobox', {
      name: 'At most, per tool'
    })
    expect(days.value).toBe('30')
    expect(count.value).toBe('50')
    expect([...days.options].map((option) => option.text)).toEqual([
      '7 days',
      '30 days',
      '90 days',
      '1 year'
    ])
    await userEvent.selectOptions(days, '365')
    expect(f.api.setSessionRange).toHaveBeenLastCalledWith({ days: 365, maxPerTool: 50 })
    await userEvent.selectOptions(count, '500')
    expect(f.api.setSessionRange).toHaveBeenLastCalledWith({ days: 30, maxPerTool: 500 })

    f.api.setSessionRange.mockRejectedValueOnce(new Error('synthetic'))
    await userEvent.selectOptions(count, '200')
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      "Couldn't save session history. Try again."
    )
    expect(count.value).toBe('50')
  })
})
