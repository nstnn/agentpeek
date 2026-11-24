import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { AgentTool } from '../../core/tools'
import type { RemoteSettingsView, RemoteStatusView } from '../../shared/remote-settings'
import { App } from './App'
import { SettingsDialog } from './SettingsDialog'
import { useRemoteAlias } from './remote-status'
import { createSessionsStore } from './sessions-store'
import { fakeApi, session, snapshot } from '../test-support'

// TASK-042: Remote View outside Settings. Invented values only.
const SETTINGS: RemoteSettingsView = {
  enabled: true,
  ownerLogin: 'owner@example.com',
  hostName: 'synthetic-mac.example-tailnet.ts.net',
  port: 47613,
  sharedWorkspaces: ['/synthetic/project'],
  shareTitles: false
}
const on = (change: Partial<RemoteSettingsView> = {}, streams = 0): RemoteStatusView => ({
  state: 'on',
  settings: { ...SETTINGS, ...change },
  resumed: false,
  streams,
  shareMessages: false
})
const off: RemoteStatusView = {
  state: 'off',
  settings: { ...SETTINGS, enabled: false },
  startError: null
}

function mount(initial: RemoteStatusView = off) {
  const fake = fakeApi(snapshot([session('a'), session('b')]))
  fake.api.getRemoteStatus.mockResolvedValue(initial)
  Object.defineProperty(window, 'agentpeek', { value: fake.api, configurable: true })
  const store = createSessionsStore(fake.api)
  store.setGrouping('status')
  const view = render(<App store={store} />)
  const announce = (status: RemoteStatusView) =>
    act(() => {
      fake.remote(status)
    })
  return { ...fake, ...view, announce }
}

const label = () => screen.queryByRole('button', { name: /^Remote View on/ })

describe('Remote View sidebar label', () => {
  it('shows only while the listener runs, with the Settings status line as its tooltip', async () => {
    const f = mount()
    await screen.findByRole('option', { name: /Synthetic a/ })
    expect(label()).toBeNull()
    f.announce(on())
    expect(label()!.getAttribute('title')).toBe('On, port 47613. Sharing 1 project.')
    expect(label()!.textContent).toBe('Remote View on')
    f.announce(on({}, 2))
    expect(label()!.getAttribute('title')).toBe('On, port 47613. 2 viewer pages open.')
    f.announce({ ...off, startError: 'port-in-use' })
    expect(label()).toBeNull()
    // A pending enable is not on yet.
    f.announce({ ...off, pending: true, requestedEnabled: true })
    expect(label()).toBeNull()
  })

  it('says when recent messages are shared, and stops saying it at once', async () => {
    const f = mount(on())
    await waitFor(() => expect(label()).not.toBeNull())
    expect(label()!.textContent).toBe('Remote View on')
    f.announce({ ...on(), shareMessages: true } as RemoteStatusView)
    expect(label()!.textContent).toBe('Remote View onMessages shared')
    expect(label()!.getAttribute('aria-label')).toBe(
      'Remote View on · messages shared. On, port 47613. Sharing 1 project.'
    )
    f.announce(on())
    expect(label()!.textContent).toBe('Remote View on')
    f.announce({ ...on(), shareMessages: true } as RemoteStatusView)
    f.announce(off)
    expect(label()).toBeNull()
  })

  it('appears at launch for a resumed listener and opens Settings', async () => {
    const f = mount({ ...on(), state: 'on', resumed: true } as RemoteStatusView)
    await waitFor(() => expect(label()).not.toBeNull())
    expect(label()!.getAttribute('title')).toBe(
      'On, port 47613. Turned on again because it was on when AgentPeek quit.'
    )
    // A viewer page replaces the one-time resume notice.
    act(() => f.remote({ ...on({}, 1), resumed: true } as RemoteStatusView))
    expect(label()!.getAttribute('title')).toBe('On, port 47613. 1 viewer page open.')
    await userEvent.click(label()!)
    expect(await screen.findByRole('dialog', { name: 'Settings' })).toBeTruthy()
  })
})

describe('Remote View alias in the session detail', () => {
  async function open() {
    await userEvent.click(await screen.findByRole('option', { name: /Synthetic a/ }))
    await screen.findByText('No recent messages.')
  }
  const alias = () => screen.queryByText(/^Remote: /)

  it('shows the main process alias while on with titles hidden, and clears it at once', async () => {
    const f = mount(on())
    f.api.getRemoteAlias.mockResolvedValue('Session 2')
    await open()
    await waitFor(() => expect(alias()?.textContent).toBe('Remote: Session 2'))
    expect(f.api.getRemoteAlias).toHaveBeenLastCalledWith({ tool: 'codex', id: 'a' })
    f.announce(on({ shareTitles: true }))
    expect(alias()).toBeNull()
    f.announce(on())
    await waitFor(() => expect(alias()?.textContent).toBe('Remote: Session 2'))
    f.announce(off)
    expect(alias()).toBeNull()
  })

  it('asks again after a restart and shows the new alias, never the old one', async () => {
    const f = mount(on())
    f.api.getRemoteAlias.mockResolvedValue('Session 1')
    await open()
    await waitFor(() => expect(alias()?.textContent).toBe('Remote: Session 1'))
    let answer: (value: string | null) => void = () => undefined
    f.api.getRemoteAlias.mockImplementation(() => new Promise((resolve) => (answer = resolve)))
    f.announce(on({ port: 47614 }))
    expect(alias()).toBeNull()
    await act(async () => {
      answer('Session 3')
      await Promise.resolve()
    })
    expect(alias()?.textContent).toBe('Remote: Session 3')
  })

  it('shows nothing for a session the main process does not share', async () => {
    const f = mount(on())
    f.api.getRemoteAlias.mockResolvedValue(null)
    await open()
    await waitFor(() => expect(f.api.getRemoteAlias).toHaveBeenCalled())
    expect(alias()).toBeNull()
  })

  it('does not ask while Remote View is off', async () => {
    const f = mount(off)
    await open()
    expect(f.api.getRemoteAlias).not.toHaveBeenCalled()
    expect(alias()).toBeNull()
  })

  it('does not ask for an ineligible tool even while Remote View is on', () => {
    const f = fakeApi(snapshot())
    const ANTIGRAVITY: AgentTool = 'antigravity'
    function Probe() {
      const value = useRemoteAlias(f.api, { tool: ANTIGRAVITY, id: 'ag-1' }, on(), 1)
      return <span data-testid="probe">{value ?? 'none'}</span>
    }
    render(<Probe />)
    expect(screen.getByTestId('probe').textContent).toBe('none')
    expect(f.api.getRemoteAlias).not.toHaveBeenCalled()
  })
})

it('updates the viewer page count in open Settings when a page connects', async () => {
  const f = fakeApi(snapshot([session('a')]))
  f.api.getRemoteStatus.mockResolvedValue(on())
  render(<SettingsDialog api={f.api} snapshot={snapshot([session('a')])} onClose={() => {}} />)
  const section = await screen.findByRole('region', { name: 'Remote View' })
  await within(section).findByText('On, port 47613. Sharing 1 project.')
  act(() => f.remote(on({}, 1)))
  expect(within(section).getByText('On, port 47613. 1 viewer page open.')).toBeTruthy()
  act(() => f.remote(on({}, 0)))
  expect(within(section).getByText('On, port 47613. Sharing 1 project.')).toBeTruthy()
})
