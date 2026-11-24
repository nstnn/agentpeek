import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { AgentTool } from '../../core/tools'
import type { RemoteSettingsView, RemoteStatusView } from '../../shared/remote-settings'
import { SettingsDialog } from './SettingsDialog'
import { candidateFolders } from './remote-folders'
import { fakeApi, session, snapshot } from '../test-support'

// Invented values only: never a real login or tailnet name.
const LOGIN = 'owner@example.com'
const HOST = 'synthetic-mac.example-tailnet.ts.net'
const FRESH: RemoteSettingsView = {
  enabled: false,
  ownerLogin: '',
  hostName: '',
  port: 47613,
  sharedWorkspaces: [],
  shareTitles: false
}
const CONFIGURED: RemoteSettingsView = { ...FRESH, ownerLogin: LOGIN, hostName: HOST }
const off = (settings: RemoteSettingsView, startError: 'port-in-use' | null = null) =>
  ({ state: 'off', settings, startError }) as const
const on = (settings: RemoteSettingsView, streams = 0, resumed = false, shareMessages = false) =>
  ({
    state: 'on',
    settings: { ...settings, enabled: true },
    streams,
    resumed,
    shareMessages
  }) as const

function mount(status: RemoteStatusView = off(FRESH), sessions = [session('a')]) {
  const fake = fakeApi(snapshot(sessions))
  fake.api.getRemoteStatus.mockResolvedValue(status)
  const view = render(
    <SettingsDialog api={fake.api} snapshot={snapshot(sessions)} onClose={() => undefined} />
  )
  const section = () => screen.getByRole('region', { name: 'Remote View' })
  const remoteSwitch = () => within(section()).getByRole('switch', { name: 'Remote View' })
  return { ...fake, ...view, section, remoteSwitch }
}

describe('Remote View settings', () => {
  it('starts off and disabled on a fresh install, with setup steps and what leaves the Mac', async () => {
    const f = mount()
    await screen.findByText('Add your Tailscale login and Mac address to turn on Remote View.')
    expect(f.remoteSwitch().getAttribute('aria-checked')).toBe('false')
    expect((f.remoteSwitch() as HTMLButtonElement).disabled).toBe(true)
    const leaves = within(f.section()).getByRole('group', { name: 'What leaves this Mac' })
    expect(leaves.textContent).toContain('folder name of each shared project, never its path')
    expect(leaves.textContent).toContain('Session titles only when Share session titles is on')
    expect(leaves.textContent).toContain(
      'Recent messages only while Share recent messages is on: the latest 20 prompts and replies'
    )
    expect(leaves.textContent).toContain('Never sent: full conversation history, files')
    expect(leaves.textContent).toContain('input or output, link targets, session IDs')
    expect(leaves.textContent).toContain(
      'A file path leaves only as text written in a shared message'
    )
    expect(leaves.textContent).toContain(
      'with Share recent messages off, no message or reply text is sent.'
    )
    const messages = within(f.section()).getByRole('switch', { name: 'Share recent messages' })
    expect(messages.getAttribute('aria-checked')).toBe('false')
    expect((messages as HTMLButtonElement).disabled).toBe(true)
    const setup = f.section().querySelector('details')!
    expect(setup.textContent).toContain('Tailnet Lock')
    expect(setup.textContent).toContain('neutral machine name')
    expect(setup.textContent).toContain('HTTPS certificates')
    expect(setup.textContent).toContain('tailscale serve --bg --https=443 http://127.0.0.1:47613')
    expect(setup.textContent).toContain('Never use tailscale funnel for this port')
    expect(setup.textContent).toContain('tailscale serve reset')
    expect(setup.textContent).toContain(
      'remove it from your tailnet in the Tailscale admin console'
    )
    expect(setup.textContent).toContain('access controls (ACLs)')
    expect(setup.textContent).toContain('Neither takes back what a device already showed')
    expect(within(f.section()).queryByText(/Viewer address/)).toBeNull()
    expect(f.api.setRemoteEnabled).not.toHaveBeenCalled()
  })

  it('shows the main-process validation inline and keeps the saved values on Cancel', async () => {
    const f = mount()
    const login = await screen.findByRole<HTMLInputElement>('textbox', { name: 'Tailscale login' })
    await userEvent.type(login, 'not a login')
    await userEvent.type(screen.getByRole('textbox', { name: 'Mac address' }), 'mac.local')
    const port = screen.getByRole<HTMLInputElement>('textbox', { name: 'Port' })
    await userEvent.clear(port)
    await userEvent.type(port, '80')
    expect(screen.getByText('Unsaved changes.')).toBeTruthy()
    f.api.saveRemoteConnection.mockResolvedValueOnce({
      ok: false,
      error: 'invalid',
      invalid: ['ownerLogin', 'hostName', 'port']
    })
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(f.api.saveRemoteConnection).toHaveBeenCalledWith({
      ownerLogin: 'not a login',
      hostName: 'mac.local',
      port: 80
    })
    await screen.findByText('Enter a login like you@example.com.')
    expect(screen.getByText('Enter the full name ending in .ts.net.')).toBeTruthy()
    expect(screen.getByText('Use a port from 1024 to 65535.')).toBeTruthy()
    expect(login.getAttribute('aria-invalid')).toBe('true')
    await userEvent.clear(port)
    await userEvent.type(port, '12ab')
    f.api.saveRemoteConnection.mockResolvedValueOnce({
      ok: false,
      error: 'invalid',
      invalid: ['port']
    })
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(f.api.saveRemoteConnection).toHaveBeenLastCalledWith(
      expect.objectContaining({ port: Number.NaN })
    )
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(login.value).toBe('')
    expect(port.value).toBe('47613')
    expect(screen.queryByText('Enter a login like you@example.com.')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
  })

  it('reports a failed save and changes nothing, then saves and enables the switch', async () => {
    const f = mount()
    const login = await screen.findByRole('textbox', { name: 'Tailscale login' })
    await userEvent.type(login, LOGIN)
    await userEvent.type(screen.getByRole('textbox', { name: 'Mac address' }), HOST)
    f.api.saveRemoteConnection.mockResolvedValueOnce({ ok: false, error: 'save-failed' })
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect((await screen.findByRole('alert')).textContent).toBe(
      "Couldn't save connection settings. Previous connection settings are kept. Check the Remote View status above and try again."
    )
    expect((f.remoteSwitch() as HTMLButtonElement).disabled).toBe(true)
    f.api.getRemoteStatus.mockResolvedValue(off(CONFIGURED))
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByText('Saved.')
    await screen.findByText('Off. Nothing is shared.')
    expect((f.remoteSwitch() as HTMLButtonElement).disabled).toBe(false)
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    expect(within(f.section()).getByText(/^Viewer address:/).textContent).toBe(
      `Viewer address: https://${HOST}/`
    )
  })

  it('keeps a later "Saved." for its own 3 s, not until an earlier save\'s timer', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const f = mount(off(CONFIGURED))
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
      const port = await screen.findByRole('textbox', { name: 'Port' })
      await user.clear(port)
      await user.type(port, '50001')
      await user.click(screen.getByRole('button', { name: 'Save' }))
      await screen.findByText('Saved.')
      f.api.getRemoteStatus.mockResolvedValue(off({ ...CONFIGURED, port: 50001 }))
      await act(() => vi.advanceTimersByTimeAsync(2000))
      await user.clear(port)
      await user.type(port, '50002')
      await user.click(screen.getByRole('button', { name: 'Save' }))
      await act(() => vi.advanceTimersByTimeAsync(1500))
      expect(screen.getByText('Saved.')).toBeTruthy()
      await act(() => vi.advanceTimersByTimeAsync(2000))
      expect(screen.queryByText('Saved.')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('turns on with zero projects and says the page shows an empty list (A02)', async () => {
    const f = mount(off(CONFIGURED))
    await screen.findByText('Off. Nothing is shared.')
    f.api.getRemoteStatus.mockResolvedValue(on(CONFIGURED))
    await userEvent.click(f.remoteSwitch())
    expect(f.api.setRemoteEnabled).toHaveBeenCalledWith(true)
    await screen.findByText(
      'On, port 47613. No projects shared yet, so the page shows an empty list.'
    )
    expect(f.remoteSwitch().getAttribute('aria-checked')).toBe('true')
    expect(within(f.section()).getByText('No projects shared.')).toBeTruthy()
  })

  it('shows port in use as a typed error and stays off', async () => {
    const f = mount(off(CONFIGURED))
    await screen.findByText('Off. Nothing is shared.')
    f.api.setRemoteEnabled.mockResolvedValueOnce({ ok: false, error: 'port-in-use' })
    f.api.getRemoteStatus.mockResolvedValue(off(CONFIGURED, 'port-in-use'))
    await userEvent.click(f.remoteSwitch())
    await screen.findByText(
      'Port 47613 is already used by another app. Choose another port, save, and turn Remote View on again.'
    )
    expect(f.remoteSwitch().getAttribute('aria-checked')).toBe('false')
  })

  it('warns when "off" could not be saved, and says when it resumed at launch', async () => {
    const f = mount(on(CONFIGURED, 0, true))
    await screen.findByText(
      'On, port 47613. Turned on again because it was on when AgentPeek quit.'
    )
    f.api.setRemoteEnabled.mockResolvedValueOnce({ ok: false, error: 'save-failed' })
    f.api.getRemoteStatus.mockResolvedValue(off(CONFIGURED))
    await userEvent.click(f.remoteSwitch())
    expect(f.api.setRemoteEnabled).toHaveBeenCalledWith(false)
    expect((await screen.findByRole('alert')).textContent).toBe(
      "Remote View is off for now, but the setting couldn't be saved. It may turn on again next time AgentPeek opens."
    )
    expect(f.remoteSwitch().getAttribute('aria-checked')).toBe('false')
  })

  it('asks again while the main process is still loading the settings', async () => {
    const f = mount({ state: 'loading' })
    await screen.findByText('Loading Remote View settings…')
    f.api.getRemoteStatus.mockResolvedValue(off(CONFIGURED))
    await screen.findByText('Off. Nothing is shared.', undefined, { timeout: 2000 })
  })

  it('counts open viewer pages without naming a device', async () => {
    mount(on({ ...CONFIGURED, sharedWorkspaces: ['/synthetic/project'] }, 2))
    await screen.findByText('On, port 47613. 2 viewer pages open.')
  })

  it('keeps Remote View off after a load failure and reads again on Try Again', async () => {
    const f = mount({ state: 'load-failed' })
    await screen.findByText("Couldn't load Remote View settings. Remote View stays off.")
    expect((f.remoteSwitch() as HTMLButtonElement).disabled).toBe(true)
    f.api.getRemoteStatus.mockResolvedValue(off(CONFIGURED))
    await userEvent.click(within(f.section()).getByRole('button', { name: 'Try Again' }))
    expect(f.api.retryRemoteLoad).toHaveBeenCalledTimes(1)
    await screen.findByText('Off. Nothing is shared.')
  })

  it('adds a listed folder by name, removes it, and reports a failed update', async () => {
    const sessions = [
      session('a', {
        summary: { ...session('a').summary, workspacePath: '/synthetic/work/demo' }
      }),
      session('b', { summary: { ...session('b').summary, workspacePath: null } })
    ]
    const f = mount(off(CONFIGURED), sessions)
    await userEvent.click(await screen.findByRole('button', { name: 'Add Project…' }))
    const list = screen.getByRole('list', { name: 'Project folders' })
    expect(
      within(list)
        .getAllByRole('button')
        .map((b) => b.textContent)
    ).toEqual(['demo/synthetic/work/'])
    f.api.getRemoteStatus.mockResolvedValue(
      off({ ...CONFIGURED, sharedWorkspaces: ['/synthetic/work/demo'] })
    )
    await userEvent.click(within(list).getByRole('button', { name: /demo/ }))
    expect(f.api.setRemoteWorkspaceShared).toHaveBeenCalledWith('/synthetic/work/demo', true)
    const remove = await screen.findByRole('button', { name: 'Remove demo' })
    f.api.setRemoteWorkspaceShared.mockResolvedValueOnce({ ok: false, error: 'save-failed' })
    await userEvent.click(remove)
    expect(f.api.setRemoteWorkspaceShared).toHaveBeenLastCalledWith('/synthetic/work/demo', false)
    expect((await screen.findByRole('alert')).textContent).toBe(
      "Couldn't update shared projects. Try again."
    )
  })

  it('toggles title sharing and reports a failed update', async () => {
    const f = mount(off(CONFIGURED))
    const titles = await screen.findByRole('switch', { name: 'Share session titles' })
    expect(titles.getAttribute('aria-checked')).toBe('false')
    f.api.getRemoteStatus.mockResolvedValue(off({ ...CONFIGURED, shareTitles: true }))
    await userEvent.click(titles)
    expect(f.api.setRemoteShareTitles).toHaveBeenCalledWith(true)
    await screen.findByText('Titles are shared.')
    f.api.setRemoteShareTitles.mockResolvedValueOnce({ ok: false, error: 'save-failed' })
    await userEvent.click(titles)
    expect((await screen.findByRole('alert')).textContent).toBe(
      "Couldn't update title sharing. Try again."
    )
  })

  it('shares recent messages only while on, with copy saying text leaves the Mac', async () => {
    const f = mount(off(CONFIGURED))
    const messages = await screen.findByRole('switch', { name: 'Share recent messages' })
    // Off while Remote View is off, whatever was chosen before; never a saved setting.
    expect(messages.getAttribute('aria-checked')).toBe('false')
    expect((messages as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/Turn on Remote View to use it\./)).toBeTruthy()
    expect(CONFIGURED).not.toHaveProperty('shareMessages')

    f.api.getRemoteStatus.mockResolvedValue(on(CONFIGURED))
    f.remote(on(CONFIGURED))
    await waitFor(() => expect((messages as HTMLButtonElement).disabled).toBe(false))
    expect(messages.getAttribute('aria-checked')).toBe('false')
    const hint = document.getElementById(messages.getAttribute('aria-describedby')!)!
    expect(hint.textContent).toContain('While this is on, conversation text leaves this Mac')
    expect(hint.textContent).toContain('latest 20 prompts and replies (up to 64 KB of text)')
    expect(hint.textContent).toContain(
      'Never full history, files, tool input or output, or link targets; a path written in a message itself is sent as written.'
    )
    expect(hint.textContent).toContain(
      'Turns off when you quit AgentPeek, turn Remote View off or change the connection settings.'
    )

    // Keyboard: focus the switch and press Space.
    f.api.getRemoteStatus.mockResolvedValue(on(CONFIGURED, 0, false, true))
    messages.focus()
    await userEvent.keyboard(' ')
    expect(f.api.setRemoteShareMessages).toHaveBeenCalledWith(true)
    await screen.findByText(
      'Recent messages are shared until you turn this off, turn Remote View off or quit AgentPeek.'
    )
    expect(messages.getAttribute('aria-checked')).toBe('true')
    expect(document.activeElement).toBe(messages)

    f.api.getRemoteStatus.mockResolvedValue(on(CONFIGURED))
    await userEvent.keyboard('{Enter}')
    expect(f.api.setRemoteShareMessages).toHaveBeenLastCalledWith(false)
    await screen.findByText('Recent messages are no longer shared.')
    expect(messages.getAttribute('aria-checked')).toBe('false')

    // Remote View turning off (here announced by the main process) shows it off and disabled.
    f.api.getRemoteStatus.mockResolvedValue(off(CONFIGURED))
    f.remote(off(CONFIGURED))
    await waitFor(() => expect((messages as HTMLButtonElement).disabled).toBe(true))
    expect(messages.getAttribute('aria-checked')).toBe('false')
  })

  it('reports a refused or failed message sharing change', async () => {
    const f = mount(on(CONFIGURED))
    const messages = await screen.findByRole('switch', { name: 'Share recent messages' })
    await waitFor(() => expect((messages as HTMLButtonElement).disabled).toBe(false))
    f.api.setRemoteShareMessages.mockResolvedValueOnce({ ok: false, error: 'not-listening' })
    await userEvent.click(messages)
    expect((await screen.findByRole('alert')).textContent).toBe('Turn on Remote View first.')
    f.api.setRemoteShareMessages.mockRejectedValueOnce(new Error('synthetic'))
    await userEvent.click(messages)
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe(
        "Couldn't update message sharing. Try again."
      )
    )
    expect(messages.getAttribute('aria-checked')).toBe('false')
  })

  it('copies the command and address through fixed targets only', async () => {
    const f = mount(off({ ...CONFIGURED, port: 50123 }))
    await screen.findByText('tailscale serve --bg --https=443 http://127.0.0.1:50123')
    const section = within(f.section())
    // Each button has its own accessible name, so a screen reader can tell them apart.
    expect(section.queryAllByRole('button', { name: 'Copy' })).toEqual([])
    const address = section.getByRole('button', { name: 'Copy viewer address' })
    const command = section.getByRole('button', { name: 'Copy serve command' })
    await userEvent.click(address)
    await userEvent.click(command)
    expect(f.api.copyRemoteText.mock.calls).toEqual([['viewer-address'], ['serve-command']])
    // One "Copied" at a time: the last button pressed.
    await waitFor(() => expect(command.textContent).toBe('Copied'))
    expect(command.getAttribute('aria-label')).toBe('Copied serve command')
    expect(address.textContent).toBe('Copy')
    f.api.copyRemoteText.mockResolvedValueOnce(false)
    await userEvent.click(address)
    await waitFor(() => expect(address.textContent).toBe("Couldn't copy"))
    expect(address.getAttribute('aria-label')).toBe("Couldn't copy viewer address")
  })
})

describe('candidateFolders', () => {
  it('lists distinct exact folders of listed sessions, not shared ones or unshareable paths', () => {
    const at = (id: string, workspacePath: string | null) =>
      session(id, { summary: { ...session(id).summary, workspacePath } })
    const listed = snapshot([
      at('a', '/synthetic/b-app/'),
      at('b', '/synthetic/b-app'),
      at('c', '/synthetic/a-app'),
      at('d', '/'),
      at('e', null),
      at('f', 'relative'),
      at('g', '/synthetic/shared')
    ])
    expect(candidateFolders(listed, ['/synthetic/shared'])).toEqual([
      '/synthetic/a-app',
      '/synthetic/b-app'
    ])
    expect(candidateFolders(null, [])).toEqual([])
  })

  it('excludes Antigravity-only and off-source folders while keeping mixed folders (CONSTRAINT-004)', () => {
    const ANTIGRAVITY: AgentTool = 'antigravity'
    const listed = snapshot(
      [
        session('ag-only', {
          key: { tool: ANTIGRAVITY, id: 'ag-only' },
          summary: { ...session('ag-only').summary, workspacePath: '/synthetic/ag-only' }
        }),
        session('ag-mixed', {
          key: { tool: ANTIGRAVITY, id: 'ag-mixed' },
          summary: { ...session('ag-mixed').summary, workspacePath: '/synthetic/mixed' }
        }),
        session('cx-mixed', {
          key: { tool: 'codex', id: 'cx-mixed' },
          summary: { ...session('cx-mixed').summary, workspacePath: '/synthetic/mixed' }
        }),
        session('cl-off', {
          key: { tool: 'claude', id: 'cl-off' },
          summary: { ...session('cl-off').summary, workspacePath: '/synthetic/claude-off' }
        })
      ],
      {
        health: {
          codex: { state: 'connected', lastReadAt: 1 },
          claude: { state: 'off' },
          antigravity: { state: 'not-installed' }
        }
      }
    )
    expect(candidateFolders(listed, [])).toEqual(['/synthetic/mixed'])
  })
})

it('keeps an unsaved privacy warning and retry after closing and reopening Settings', async () => {
  const failed = { ...on(CONFIGURED), unsavedChanges: true as const }
  const f = mount(failed)
  await screen.findByText(/Some Remote View changes are not saved/)
  f.unmount()
  render(<SettingsDialog api={f.api} snapshot={snapshot([])} onClose={() => undefined} />)
  const retry = await screen.findByRole('button', { name: 'Retry saving Remote View settings' })
  f.api.setRemoteShareTitles.mockResolvedValueOnce({ ok: false, error: 'save-failed' })
  await userEvent.click(retry)
  expect(screen.getByText(/Some Remote View changes are not saved/)).toBeTruthy()
  f.api.getRemoteStatus.mockResolvedValue(on(CONFIGURED))
  await userEvent.click(retry)
  expect(f.api.setRemoteShareTitles).toHaveBeenLastCalledWith(false)
  await waitFor(() =>
    expect(screen.queryByText(/Some Remote View changes are not saved/)).toBeNull()
  )
})

it('shows saved connection values and OFF when the new port cannot restart', async () => {
  const f = mount(on(CONFIGURED))
  const port = await screen.findByRole<HTMLInputElement>('textbox', { name: 'Port' })
  await userEvent.clear(port)
  await userEvent.type(port, '47614')
  f.api.saveRemoteConnection.mockResolvedValueOnce({
    ok: false,
    error: 'port-in-use',
    connectionSaved: true
  })
  f.api.getRemoteStatus.mockResolvedValue(off({ ...CONFIGURED, port: 47614 }, 'port-in-use'))
  await userEvent.click(screen.getByRole('button', { name: 'Save' }))
  await screen.findByText(/Connection settings saved. Remote View is now off/)
  expect(port.value).toBe('47614')
  expect(f.remoteSwitch().getAttribute('aria-checked')).toBe('false')
  expect(screen.getByText(/Port 47614 is already used/)).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
})

it('polls a pending enable after Settings is reopened until the listener is on', async () => {
  const f = mount(off(CONFIGURED))
  let finish!: (result: { ok: true }) => void
  f.api.setRemoteEnabled.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  await screen.findByText('Off. Nothing is shared.')
  await userEvent.click(f.remoteSwitch())
  f.unmount()
  f.api.getRemoteStatus.mockResolvedValue({
    ...off(CONFIGURED),
    pending: true,
    requestedEnabled: true
  })
  render(<SettingsDialog api={f.api} snapshot={snapshot([])} onClose={() => undefined} />)
  await screen.findByText('Starting on port 47613…')
  expect(screen.getByRole('switch', { name: 'Remote View' }).getAttribute('aria-checked')).toBe(
    'true'
  )
  f.api.getRemoteStatus.mockResolvedValue(on(CONFIGURED))
  act(() => {
    finish({ ok: true })
  })
  await screen.findByText(/On, port 47613/, {}, { timeout: 2000 })
})

it('clears the obsolete title error only after retrying the effective policy succeeds', async () => {
  const f = mount(on({ ...CONFIGURED, shareTitles: true }))
  const titles = await screen.findByRole('switch', { name: 'Share session titles' })
  f.api.getRemoteStatus.mockResolvedValue({ ...on(CONFIGURED), unsavedChanges: true })
  f.api.setRemoteShareTitles.mockResolvedValueOnce({ ok: false, error: 'save-failed' })
  await userEvent.click(titles)
  await screen.findByText("Couldn't update title sharing. Try again.")
  const retry = screen.getByRole('button', { name: 'Retry saving Remote View settings' })
  f.api.setRemoteShareTitles.mockResolvedValueOnce({ ok: false, error: 'save-failed' })
  await userEvent.click(retry)
  expect(screen.getByText("Couldn't update title sharing. Try again.")).toBeTruthy()
  f.api.getRemoteStatus.mockResolvedValue(on(CONFIGURED))
  await userEvent.click(retry)
  await waitFor(() =>
    expect(screen.queryByText("Couldn't update title sharing. Try again.")).toBeNull()
  )
  expect(screen.queryByText(/Some Remote View changes are not saved/)).toBeNull()
})
