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
  return { ...fake, store, a, b, resize, ...render(<App store={store} />) }
}
const pane = (side: 'Left' | 'Right') => screen.getByRole('complementary', { name: `${side} pane` })
async function openSplit(f: ReturnType<typeof mount>) {
  await userEvent.click(await screen.findByRole('option', { name: /Synthetic a,/ }))
  act(() => f.command({ type: 'open-secondary', key: f.b.key }))
  await within(pane('Right')).findByRole('button', { name: 'Show More' })
}

describe('independent navigation visibility', () => {
  it('accepts the Views shortcut before any control has keyboard focus', async () => {
    mount()
    await screen.findByRole('option', { name: /Synthetic a,/ })
    fireEvent.keyDown(document.body, { key: 'B', metaKey: true, shiftKey: true })
    expect(screen.getByRole('button', { name: 'Expand Views' })).toBeTruthy()
  })

  it.each(['separator', 'source'] as const)(
    'restores list focus when toggling Views removes a focused %s during browsing',
    async (origin) => {
      const f = mount(760)
      await openSplit(f)
      await userEvent.click(screen.getByRole('button', { name: 'Show Sessions' }))
      if (origin === 'source')
        await userEvent.click(screen.getByRole('button', { name: 'Collapse Views' }))
      const control =
        origin === 'source'
          ? screen.getByLabelText('Codex source: Connected')
          : screen.getByRole('separator', { name: 'Sidebar width' })
      control.focus()
      fireEvent.keyDown(control, { key: 'B', metaKey: true, shiftKey: true })
      expect(document.activeElement).toBe(screen.getByRole('listbox'))
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

  it('keeps source errors named and opens keyboard-dismissible source details in the rail', async () => {
    const f = mount()
    await screen.findByRole('option', { name: /Synthetic a,/ })
    act(() =>
      f.push(
        snapshot([f.a, f.b], {
          health: {
            codex: { state: 'no-access', lastReadAt: null },
            claude: { state: 'connected', lastReadAt: NOW }
          }
        })
      )
    )
    await userEvent.click(screen.getByRole('button', { name: 'Collapse Views' }))
    const trigger = screen.getByLabelText('Codex source: No access')
    await userEvent.click(trigger)
    const disclosure = trigger.closest('details')!
    expect(disclosure.open).toBe(true)
    expect(within(disclosure).getByRole('heading', { name: 'Codex' })).toBeTruthy()
    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(disclosure.open).toBe(false)
    expect(document.activeElement).toBe(trigger)
    expect(screen.getByRole('listbox')).toBeTruthy()
  })
})
