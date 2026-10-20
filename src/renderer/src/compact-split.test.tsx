import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { RecentMessages } from '../../core/session'
import { fakeApi, NOW, session, snapshot } from '../test-support'
import { App } from './App'
import { createSessionsStore } from './sessions-store'

function mount(width: number) {
  let currentWidth = width
  const queries: { query: string; listeners: Set<() => void> }[] = []
  vi.spyOn(window, 'matchMedia').mockImplementation((query) => {
    const listeners = new Set<() => void>()
    queries.push({ query, listeners })
    return {
      get matches() {
        return query.includes('max-width') ? currentWidth < 1000 : currentWidth >= 1300
      },
      addEventListener: (_: string, callback: () => void) => listeners.add(callback),
      removeEventListener: (_: string, callback: () => void) => listeners.delete(callback)
    } as unknown as MediaQueryList
  })
  const f = fakeApi(snapshot([session('a'), session('b'), session('c')]))
  f.api.getMessages.mockImplementation((key) =>
    Promise.resolve({
      kind: 'messages',
      hasOlder: false,
      messages: [{ kind: 'reply', text: `${key.id} synthetic line\n`.repeat(500), at: NOW }]
    })
  )
  Object.defineProperty(window, 'agentpeek', { value: f.api, configurable: true })
  const store = createSessionsStore(f.api)
  const rendered = render(<App store={store} />)
  return {
    ...f,
    store,
    ...rendered,
    resize(next: number) {
      act(() => {
        currentWidth = next
        queries.forEach(({ listeners }) => listeners.forEach((callback) => callback()))
      })
    }
  }
}
const pane = (name: 'Main' | 'Second') =>
  screen.getByRole('complementary', { name: `${name} pane` })
const choose = async (id: string) =>
  userEvent.click(await screen.findByRole('option', { name: new RegExp(`Synthetic ${id},`) }))
async function open() {
  await choose('a')
  await userEvent.click(screen.getByRole('button', { name: 'Open in Second Pane' }))
  await within(pane('Second')).findByRole('button', { name: 'Show More' })
}

describe('responsive split navigation', () => {
  it.each([999, 1000, 1299, 1300, 1440])(
    'presents the intended panes and navigation at %i content pixels',
    async (width) => {
      const f = mount(width)
      await open()
      expect(screen.queryByRole('complementary', { name: 'Main pane' }) !== null).toBe(
        width >= 1000
      )
      expect(pane('Second')).toBeTruthy()
      expect(screen.queryByRole('listbox') !== null).toBe(width >= 1300)
      expect(screen.queryByRole('button', { name: 'Show Sessions' }) !== null).toBe(width < 1300)
      expect(f.api.setDetailOpen).toHaveBeenLastCalledWith(width < 1300)
      if (width < 1000)
        expect(
          screen.getByRole('radio', { name: 'Second pane' }).getAttribute('aria-checked')
        ).toBe('true')
    }
  )

  it('retains mounted transcripts, disclosures, scroll and browsing intent through every width band', async () => {
    const f = mount(1440)
    await open()
    await userEvent.click(within(pane('Second')).getByRole('button', { name: 'Show More' }))
    const second = within(pane('Second')).getByRole('region')
    fireEvent.scroll(second, { target: { scrollTop: 81 } })
    await choose('c')
    await userEvent.click(await within(pane('Main')).findByRole('button', { name: 'Show More' }))
    const main = within(pane('Main')).getByRole('region')
    fireEvent.scroll(main, { target: { scrollTop: 42 } })
    const list = screen.getByRole('listbox')
    list.focus()
    f.resize(1299)
    expect(document.activeElement).toBe(pane('Main'))
    f.resize(999)
    expect(pane('Main')).toBeTruthy()
    await userEvent.click(screen.getByRole('radio', { name: 'Second pane' }))
    expect(f.store.getSnapshot().activePane).toBe('second')
    await userEvent.click(screen.getByRole('button', { name: 'Show Sessions' }))
    expect(document.activeElement).toBe(list)
    f.resize(1440)
    expect(screen.queryByRole('complementary', { name: 'Second pane' })).toBeNull()
    expect(f.api.setDetailOpen).toHaveBeenLastCalledWith(false)
    await userEvent.click(screen.getByRole('button', { name: 'Return to Sessions' }))
    expect(f.store.getSnapshot().activePane).toBe('second')
    expect(document.activeElement).toBe(pane('Second'))
    expect(within(pane('Second')).getByRole('region')).toBe(second)
    expect(within(pane('Main')).getByRole('region')).toBe(main)
    expect(second.scrollTop).toBe(81)
    expect(main.scrollTop).toBe(42)
    expect(within(pane('Second')).getByRole('button', { name: 'Collapse Message' })).toBeTruthy()
    expect(within(pane('Main')).getByRole('button', { name: 'Collapse Message' })).toBeTruthy()
  })

  it('uses arrow selectors, Escape/native Back and browse arrows/Enter without loading hidden selections', async () => {
    const f = mount(999)
    await open()
    const secondSelector = screen.getByRole('radio', { name: 'Second pane' })
    secondSelector.focus()
    await userEvent.keyboard('{ArrowLeft}')
    expect(f.store.getSnapshot().activePane).toBe('main')
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Main pane' }))
    await userEvent.keyboard('{End}')
    expect(f.store.getSnapshot().activePane).toBe('second')
    await userEvent.keyboard('{Escape}')
    const list = screen.getByRole('listbox')
    expect(document.activeElement).toBe(list)
    f.api.getMessages.mockClear()
    await userEvent.keyboard('{End}')
    expect(f.store.getSnapshot().selection?.session.key.id).toBe('c')
    expect(f.store.getSnapshot().activePane).toBeNull()
    expect(f.api.getMessages).not.toHaveBeenCalled()
    await userEvent.keyboard('{Enter}')
    expect(document.activeElement).toBe(pane('Main'))
    expect(f.store.getSnapshot().activePane).toBe('main')
    act(() => f.command('back'))
    expect(document.activeElement).toBe(list)
    act(() => f.command({ type: 'open-secondary', key: session('b').key }))
    expect(document.activeElement).toBe(pane('Second'))
    expect(f.store.getSnapshot().selection?.session.key.id).toBe('c')
    await userEvent.click(screen.getByRole('button', { name: 'Close Second Pane' }))
    expect(screen.queryByRole('radiogroup', { name: 'Visible session pane' })).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '‹ Active' }))
    expect(f.store.getSnapshot()).toMatchObject({ activePane: 'main', detailOpen: true })
  })

  it('defers hidden updates, rejects late hidden results and does not acknowledge a pane revealed by resize', async () => {
    const f = mount(999)
    await choose('a')
    await screen.findByRole('button', { name: 'Show More' })
    let finish!: (messages: RecentMessages) => void
    f.api.getMessages.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    fireEvent.focus(window)
    act(() => f.command({ type: 'open-secondary', key: session('b').key }))
    await userEvent.click(screen.getByRole('button', { name: 'Show Sessions' }))
    f.api.getMessages.mockClear()
    f.api.markRead.mockClear()
    const a = session('a', {
      lastReply: {
        cursor: 'a-new',
        completedAt: NOW,
        isError: false,
        errorCode: null,
        newerTurnStarted: false
      },
      attention: { waiting: false, newReply: true, error: false }
    })
    act(() => {
      f.push(snapshot([a, session('b'), session('c')]))
      finish({
        kind: 'messages',
        hasOlder: false,
        messages: [{ kind: 'reply', text: 'Late hidden text', at: NOW }]
      })
    })
    expect(f.api.getMessages).not.toHaveBeenCalled()
    expect(f.api.markRead).not.toHaveBeenCalled()
    expect(screen.queryByText('Late hidden text')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Return to Sessions' }))
    await within(pane('Second')).findByRole('button', { name: 'Show More' })
    f.api.getMessages.mockClear()
    f.resize(1000)
    await within(pane('Main')).findByRole('button', { name: 'Show More' })
    expect(f.api.getMessages).toHaveBeenCalledWith(a.key, 20)
    expect(f.api.markRead).not.toHaveBeenCalled()
    expect(f.store.getSnapshot().activePane).toBe('second')
    await userEvent.click(within(pane('Main')).getByRole('button', { name: 'Pin' }))
    await vi.waitFor(() => expect(f.api.markRead).toHaveBeenCalledWith(a.key, 'a-new'))
  })

  it('returns to retained Second after clearing Main and closes cleanly from browsing', async () => {
    const f = mount(1100)
    await open()
    await userEvent.click(screen.getByRole('button', { name: 'Show Sessions' }))
    await userEvent.click(screen.getByRole('radio', { name: 'Codex 3' }))
    expect(f.store.getSnapshot().selection).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Return to Sessions' }))
    expect(document.activeElement).toBe(pane('Second'))
    await userEvent.click(screen.getByRole('button', { name: 'Show Sessions' }))
    await userEvent.click(screen.getByRole('button', { name: 'Close Second Pane' }))
    expect(document.activeElement).toBe(screen.getByRole('listbox'))
    expect(f.store.getSnapshot()).toMatchObject({
      secondarySelection: null,
      activePane: null,
      detailOpen: false
    })
  })
})
