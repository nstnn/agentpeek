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
const pane = (name: 'Left' | 'Right') => screen.getByRole('complementary', { name: `${name} pane` })
const choose = async (id: string) =>
  userEvent.click(await screen.findByRole('option', { name: new RegExp(`Synthetic ${id},`) }))
async function open(f: ReturnType<typeof mount>) {
  await choose('a')
  act(() => f.command({ type: 'open-secondary', key: session('a').key }))
  await within(pane('Right')).findByRole('button', { name: 'Show More' })
}

describe('responsive split navigation', () => {
  it.each([760, 999, 1000, 1299])(
    'closes Left at %i pixels and keeps Right in the single detail with usable focus',
    async (width) => {
      const f = mount(width)
      await choose('a')
      act(() => f.command({ type: 'open-secondary', key: session('b').key }))
      await within(pane('Right')).findByRole('button', { name: 'Show More' })
      if (width < 1000)
        await userEvent.click(screen.getByRole('radio', { name: 'Synthetic a (Left pane)' }))
      await userEvent.click(within(pane('Left')).getByRole('button', { name: 'Close Left Pane' }))
      const detail = screen.getByRole('complementary', { name: 'Session detail' })
      await within(detail).findByRole('heading', { name: 'Synthetic b' })
      expect(screen.queryByRole('radiogroup', { name: 'Visible session pane' })).toBeNull()
      expect(f.store.getSnapshot()).toMatchObject({
        selection: { session: { key: session('b').key } },
        secondarySelection: null,
        activePane: 'main',
        detailOpen: width < 1000
      })
      expect(document.activeElement).toBe(
        width < 1000 ? screen.getByRole('button', { name: '‹ Active' }) : detail
      )
    }
  )

  it.each([999, 1000, 1299, 1300, 1440])(
    'presents the intended panes and navigation at %i content pixels',
    async (width) => {
      const f = mount(width)
      await open(f)
      expect(screen.queryByRole('complementary', { name: 'Left pane' }) !== null).toBe(
        width >= 1000
      )
      expect(pane('Right').querySelector('.pane-title')?.textContent).toBe('Synthetic a')
      if (width >= 1000)
        expect(pane('Left').querySelector('.pane-title')?.textContent).toBe('Synthetic a')
      expect(screen.queryByRole('listbox') !== null).toBe(width >= 1300)
      expect(screen.queryByRole('button', { name: 'Show Sessions' }) !== null).toBe(width < 1300)
      expect(f.api.setDetailOpen).toHaveBeenLastCalledWith(width < 1300)
      if (width < 1000)
        expect(
          screen
            .getByRole('radio', { name: 'Synthetic a (Right pane)' })
            .getAttribute('aria-checked')
        ).toBe('true')
    }
  )

  it('retains mounted transcripts, disclosures, scroll and browsing intent through every width band', async () => {
    const f = mount(1440)
    await open(f)
    await userEvent.click(within(pane('Right')).getByRole('button', { name: 'Show More' }))
    const second = within(pane('Right')).getByRole('region')
    fireEvent.scroll(second, { target: { scrollTop: 81 } })
    fireEvent.pointerDown(pane('Left'))
    await choose('c')
    await userEvent.click(await within(pane('Left')).findByRole('button', { name: 'Show More' }))
    const main = within(pane('Left')).getByRole('region')
    fireEvent.scroll(main, { target: { scrollTop: 42 } })
    const list = screen.getByRole('listbox')
    list.focus()
    f.resize(1299)
    expect(document.activeElement).toBe(pane('Left'))
    f.resize(999)
    expect(pane('Left').querySelector('.pane-title')?.textContent).toBe('Synthetic c')
    expect(screen.getByRole('radio', { name: 'Synthetic c (Left pane)' }).textContent).toBe(
      'Synthetic c'
    )
    await userEvent.click(screen.getByRole('radio', { name: 'Synthetic a (Right pane)' }))
    expect(f.store.getSnapshot().activePane).toBe('second')
    await userEvent.click(screen.getByRole('button', { name: 'Show Sessions' }))
    expect(document.activeElement).toBe(list)
    f.resize(1440)
    expect(screen.queryByRole('complementary', { name: 'Right pane' })).toBeNull()
    expect(f.api.setDetailOpen).toHaveBeenLastCalledWith(false)
    await userEvent.click(screen.getByRole('button', { name: 'Return to Sessions' }))
    expect(f.store.getSnapshot().activePane).toBe('second')
    expect(document.activeElement).toBe(pane('Right'))
    expect(within(pane('Right')).getByRole('region')).toBe(second)
    expect(within(pane('Left')).getByRole('region')).toBe(main)
    expect(second.scrollTop).toBe(81)
    expect(main.scrollTop).toBe(42)
    expect(within(pane('Right')).getByRole('button', { name: 'Collapse Message' })).toBeTruthy()
    expect(within(pane('Left')).getByRole('button', { name: 'Collapse Message' })).toBeTruthy()
  })

  it('uses arrow selectors, Escape/native Back and browse arrows/Enter without loading hidden selections', async () => {
    const f = mount(999)
    await open(f)
    const secondSelector = screen.getByRole('radio', { name: 'Synthetic a (Right pane)' })
    secondSelector.focus()
    await userEvent.keyboard('{ArrowLeft}')
    expect(f.store.getSnapshot().activePane).toBe('main')
    expect(document.activeElement).toBe(
      screen.getByRole('radio', { name: 'Synthetic a (Left pane)' })
    )
    await userEvent.keyboard('{End}')
    expect(f.store.getSnapshot().activePane).toBe('second')
    await userEvent.keyboard('{Escape}')
    const list = screen.getByRole('listbox')
    expect(document.activeElement).toBe(list)
    f.api.getMessages.mockClear()
    await userEvent.keyboard('{End}')
    expect(f.store.getSnapshot().listSelection?.session.key.id).toBe('c')
    expect(f.store.getSnapshot().activePane).toBeNull()
    expect(f.api.getMessages).not.toHaveBeenCalled()
    await userEvent.keyboard('{Enter}')
    expect(document.activeElement).toBe(pane('Right'))
    expect(f.store.getSnapshot().activePane).toBe('second')
    act(() => f.command('back'))
    expect(document.activeElement).toBe(list)
    act(() => f.command({ type: 'open-secondary', key: session('b').key }))
    expect(document.activeElement).toBe(pane('Right'))
    expect(f.store.getSnapshot().selection?.session.key.id).toBe('a')
    await userEvent.click(screen.getByRole('button', { name: 'Close Right Pane' }))
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
    await within(pane('Right')).findByRole('button', { name: 'Show More' })
    f.api.getMessages.mockClear()
    f.resize(1000)
    await within(pane('Left')).findByRole('button', { name: 'Show More' })
    expect(f.api.getMessages).toHaveBeenCalledWith(a.key, 20)
    expect(f.api.markRead).not.toHaveBeenCalled()
    expect(f.store.getSnapshot().activePane).toBe('second')
    await userEvent.click(within(pane('Left')).getByRole('button', { name: 'Pin' }))
    await vi.waitFor(() => expect(f.api.markRead).toHaveBeenCalledWith(a.key, 'a-new'))
  })

  it('preserves both panes through filtering and returns to the remembered pane and closes cleanly from browsing', async () => {
    const f = mount(1100)
    await open(f)
    await userEvent.click(screen.getByRole('button', { name: 'Show Sessions' }))
    await userEvent.click(screen.getByRole('radio', { name: 'Codex 3' }))
    expect(f.store.getSnapshot().selection?.session.key.id).toBe('a')
    await userEvent.click(screen.getByRole('button', { name: 'Return to Sessions' }))
    expect(document.activeElement).toBe(pane('Right'))
    await userEvent.click(screen.getByRole('button', { name: 'Show Sessions' }))
    await userEvent.click(screen.getByRole('button', { name: 'Close Right Pane' }))
    expect(document.activeElement).toBe(
      screen.getByRole('complementary', { name: 'Session detail' })
    )
    expect(f.store.getSnapshot()).toMatchObject({
      secondarySelection: null,
      activePane: 'main',
      detailOpen: false
    })
  })
})
