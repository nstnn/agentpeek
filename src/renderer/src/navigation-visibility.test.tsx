import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { fakeApi, NOW, session, snapshot } from '../test-support'
import { mockWorkspaceWidth } from '../workspace-test-support'
import { App } from './App'
import { createSessionsStore } from './sessions-store'

function mount(width = 1440) {
  const resize = mockWorkspaceWidth(width)
  const a = session('a', { pinned: true })
  const b = session('b')
  const fake = fakeApi(snapshot([a, b]))
  fake.api.getMessages.mockImplementation((key) =>
    Promise.resolve({
      kind: 'messages',
      hasOlder: false,
      messages: [{ kind: 'reply', text: `${key.id} synthetic line\n`.repeat(500), at: NOW }]
    })
  )
  Object.defineProperty(window, 'agentpeek', { value: fake.api, configurable: true })
  const store = createSessionsStore(fake.api)
  store.setGrouping('status')
  return { ...fake, store, a, b, resize, ...render(<App store={store} />) }
}
const pane = (side: 'Left' | 'Right') => screen.getByRole('complementary', { name: `${side} pane` })
async function openSplit(f: ReturnType<typeof mount>) {
  await userEvent.click(await screen.findByRole('option', { name: /Synthetic a,/ }))
  act(() => f.command({ type: 'open-secondary', key: f.b.key }))
  await within(pane('Right')).findByRole('button', { name: 'Show More' })
}

describe('independent navigation visibility', () => {
  it('moves the icon between existing headers without changing the active pane or losing focus', async () => {
    const f = mount()
    await openSplit(f)
    expect(screen.getByRole('button', { name: 'Collapse Views' }).textContent).toBe('')
    await userEvent.click(screen.getByRole('heading', { name: 'Sessions', level: 2 }))
    expect(screen.getByRole('button', { name: 'Collapse Views' })).toBeTruthy()
    const hide = screen.getByRole('button', { name: 'Hide Sessions' })
    expect(hide.textContent).toBe('')
    expect(
      screen.getByRole('heading', { name: 'Active', level: 1 }).parentElement?.contains(hide)
    ).toBe(true)
    const loads = f.api.getMessages.mock.calls.length
    await userEvent.click(hide)
    expect(document.activeElement).toBe(pane('Right'))
    const restore = screen.getByRole('button', { name: 'Show Sessions' })
    expect(restore.textContent).toBe('')
    expect(pane('Left').contains(restore)).toBe(true)
    await userEvent.click(restore)
    expect(document.activeElement).toBe(screen.getByRole('listbox'))
    expect(f.store.getSnapshot().activePane).toBe('second')
    expect(f.api.getMessages.mock.calls.length).toBe(loads)
  })

  it('accepts the Views shortcut before any control has keyboard focus', async () => {
    mount()
    await screen.findByRole('option', { name: /Synthetic a,/ })
    fireEvent.keyDown(document.body, { key: 'B', metaKey: true, shiftKey: true })
    expect(screen.getByRole('button', { name: 'Expand Views' })).toBeTruthy()
  })

  it('focuses the selected tool filter after closing the only pane when all sessions disappear', async () => {
    const f = mount()
    await screen.findByRole('option', { name: /Synthetic a,/ })
    act(() => f.command({ type: 'open-secondary', key: f.b.key }))
    await within(pane('Right')).findByRole('region')
    await userEvent.click(screen.getByRole('combobox', { name: 'Filter by tool' }))
    await userEvent.click(screen.getByRole('option', { name: /^Codex / }))
    act(() => f.push(snapshot([])))
    await userEvent.click(screen.getByRole('button', { name: 'Close Right Pane' }))
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Hide Sessions' }).disabled).toBe(
      true
    )
    const filter = screen.getByRole('combobox', { name: 'Filter by tool' })
    expect(filter.textContent).toBe('Codex 0')
    expect(document.activeElement).toBe(filter)
  })

  it.each(['separator', 'settings'] as const)(
    'retains reachable focus when toggling Views with a focused %s during browsing',
    async (origin) => {
      const f = mount(760)
      await openSplit(f)
      await userEvent.click(screen.getByRole('button', { name: 'Show Sessions' }))
      if (origin === 'settings')
        await userEvent.click(screen.getByRole('button', { name: 'Collapse Views' }))
      const control =
        origin === 'settings'
          ? screen.getByRole('button', { name: 'Settings' })
          : screen.getByRole('separator', { name: 'Sidebar width' })
      control.focus()
      fireEvent.keyDown(control, { key: 'B', metaKey: true, shiftKey: true })
      expect(document.activeElement).toBe(
        origin === 'settings' ? control : screen.getByRole('listbox')
      )
      expect(f.store.getSnapshot().activePane).toBeNull()
      expect(screen.queryByRole('complementary', { name: 'Right pane' })).toBeNull()
    }
  )

  it('reopens a retained reading session after Back between consecutive compact resize checks', async () => {
    const f = mount(800)
    await userEvent.click(await screen.findByRole('option', { name: /Synthetic a,/ }))
    const detail = screen.getByRole('complementary', { name: 'Session detail' })
    for (const width of [799, 760]) {
      f.resize(width)
      if (!screen.queryByRole('complementary', { name: 'Session detail' })) {
        await userEvent.click(screen.getByRole('option', { name: /Synthetic a,/ }))
      }
      expect(screen.getByRole('complementary', { name: 'Session detail' })).toBe(detail)
      fireEvent.keyDown(detail, { key: 'Escape' })
      expect(document.activeElement).toBe(screen.getByRole('listbox'))
    }
  })

  it('keeps both transcripts, disclosures, scroll and preferred column widths across independent toggles', async () => {
    const f = mount()
    await openSplit(f)
    const transcript = within(pane('Right')).getByRole('region')
    await userEvent.click(within(pane('Right')).getByRole('button', { name: 'Show More' }))
    fireEvent.keyDown(transcript, { key: 'PageDown' })
    fireEvent.scroll(transcript, { target: { scrollTop: 81 } })
    const sidebarDivider = screen.getByRole('separator', { name: 'Sidebar width' })
    fireEvent.keyDown(sidebarDivider, { key: 'ArrowRight', shiftKey: true })
    const preferred = sidebarDivider.getAttribute('aria-valuenow')
    const list = screen.getByRole('listbox')
    list.scrollTop = 37
    const loads = f.api.getMessages.mock.calls.length
    await userEvent.click(screen.getByRole('button', { name: 'Hide Sessions' }))
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(pane('Left')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Collapse Views' }))
    expect(screen.queryByRole('separator', { name: 'Sidebar width' })).toBeNull()
    expect(screen.queryByRole('listbox')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Show Sessions' }))
    expect(screen.getByRole('listbox')).toBe(list)
    expect(list.scrollTop).toBe(37)
    expect(screen.getByRole('button', { name: 'Expand Views' })).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Expand Views' }))
    expect(
      screen.getByRole('separator', { name: 'Sidebar width' }).getAttribute('aria-valuenow')
    ).toBe(preferred)
    expect(within(pane('Right')).getByRole('region')).toBe(transcript)
    expect(transcript.scrollTop).toBe(81)
    expect(within(pane('Right')).getByRole('button', { name: 'Collapse Message' })).toBeTruthy()
    expect(f.api.getMessages.mock.calls.length).toBe(loads)
    expect(f.store.getSnapshot().activePane).toBe('second')
  })

  it('opens the filtered list from a rail icon without replacing either reading session', async () => {
    const f = mount()
    await openSplit(f)
    const left = within(pane('Left')).getByRole('region')
    const right = within(pane('Right')).getByRole('region')
    await userEvent.click(screen.getByRole('button', { name: 'Collapse Views' }))
    await userEvent.click(screen.getByRole('button', { name: 'Hide Sessions' }))
    await userEvent.click(screen.getByRole('button', { name: 'Pinned 1' }))
    expect(screen.getAllByRole('option')).toHaveLength(1)
    expect(screen.getByRole('option').textContent).toContain('Synthetic a')
    expect(within(pane('Left')).getByRole('region')).toBe(left)
    expect(within(pane('Right')).getByRole('region')).toBe(right)
    expect(f.store.getSnapshot().activePane).toBe('second')
  })

  it('uses the reclaimed sidebar width to reveal two panes at the minimum window size', async () => {
    const f = mount(760)
    await openSplit(f)
    const right = within(pane('Right')).getByRole('region')
    expect(screen.queryByRole('complementary', { name: 'Left pane' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Collapse Views' }))
    expect(pane('Left')).toBeTruthy()
    expect(screen.queryByRole('radiogroup', { name: 'Visible session pane' })).toBeNull()
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(within(pane('Right')).getByRole('region')).toBe(right)
    expect(f.store.getSnapshot().activePane).toBe('second')
    await userEvent.click(screen.getByRole('button', { name: 'Show Sessions' }))
    expect(screen.getByRole('listbox')).toBeTruthy()
    expect(screen.queryByRole('complementary', { name: 'Right pane' })).toBeNull()
    f.resize(1440)
    expect(screen.queryByRole('complementary', { name: 'Right pane' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Hide Sessions' }))
    expect(within(pane('Right')).getByRole('region')).toBe(right)
  })

  it('keeps native view commands useful while the list is hidden, including single-pane reading', async () => {
    const f = mount()
    await userEvent.click(await screen.findByRole('option', { name: /Synthetic a,/ }))
    const detail = screen.getByRole('complementary', { name: 'Session detail' })
    await userEvent.click(screen.getByRole('button', { name: 'Hide Sessions' }))
    act(() => f.command('view:pinned'))
    expect(screen.getByRole('listbox')).toBeTruthy()
    expect(screen.getByRole('complementary', { name: 'Session detail' })).toBe(detail)
    expect(f.store.getSnapshot().selection?.session.key).toEqual(f.a.key)
  })

  it('moves focus out of hidden content through shortcuts and keeps the empty chooser reachable', async () => {
    const f = mount()
    const hide = await screen.findByRole<HTMLButtonElement>('button', { name: 'Hide Sessions' })
    expect(hide.disabled).toBe(true)
    await userEvent.click(screen.getByRole('option', { name: /Synthetic a,/ }))
    const list = screen.getByRole('listbox')
    list.focus()
    fireEvent.keyDown(list, { key: 'L', metaKey: true, shiftKey: true })
    expect(document.activeElement).toBe(
      screen.getByRole('complementary', { name: 'Session detail' })
    )
    fireEvent.keyDown(document.activeElement!, { key: 'B', metaKey: true, shiftKey: true })
    expect(screen.getByRole('button', { name: 'Expand Views' })).toBeTruthy()
    fireEvent.keyDown(document.activeElement!, { key: 'L', metaKey: true, shiftKey: true })
    expect(screen.getByRole('listbox')).toBe(list)
    expect(f.api.getMessages).toHaveBeenCalledTimes(1)
  })

  it('shows connected tools as non-interactive indicators in the sidebar and rail', async () => {
    const f = mount()
    await screen.findByRole('option', { name: /Synthetic a,/ })
    for (const layout of ['expanded', 'rail']) {
      if (layout === 'rail')
        await userEvent.click(screen.getByRole('button', { name: 'Collapse Views' }))
      for (const name of ['Codex', 'Claude Code']) {
        const indicator = screen.getByRole('img', { name: `${name} source: Connected` })
        expect(indicator.closest('.sidebar-footer')).toBeTruthy()
        expect(indicator.tabIndex).toBe(-1)
        await userEvent.click(indicator)
        expect(f.store.getSnapshot().settingsOpen).toBe(false)
      }
      const view = screen.getByRole('button', { name: 'All Sessions 2' })
      await userEvent.click(view)
      await userEvent.tab()
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Settings' }))
    }
    act(() =>
      f.push(
        snapshot([f.a, f.b], {
          health: {
            codex: { state: 'no-access', lastReadAt: null },
            claude: { state: 'connected', lastReadAt: NOW },
            antigravity: { state: 'not-installed' }
          }
        })
      )
    )
    expect(screen.queryByLabelText('Codex source: No access')).toBeNull()
    expect(screen.queryByLabelText('Codex source: Connected')).toBeNull()
    expect(screen.getByRole('img', { name: 'Claude Code source: Connected' })).toBeTruthy()
    act(() =>
      f.push(
        snapshot([f.a, f.b], {
          health: {
            codex: { state: 'connected', lastReadAt: NOW },
            claude: { state: 'connected', lastReadAt: NOW },
            antigravity: { state: 'connected', lastReadAt: NOW }
          }
        })
      )
    )
    expect(screen.getByRole('img', { name: 'Antigravity source: Connected' })).toBeTruthy()
    expect(
      [...document.querySelectorAll('.source-monogram')].map((node) => node.textContent)
    ).toEqual(['C', 'A', 'G'])
    await userEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(f.store.getSnapshot().settingsOpen).toBe(true)
  })
})
