import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { RecentMessages, Session } from '../../core/session'
import { fakeApi, NOW, session, snapshot } from '../test-support'
import { SessionDetail } from './SessionDetail'
import { App } from './App'
import { createSessionsStore } from './sessions-store'

const exchange: RecentMessages = {
  kind: 'messages',
  hasOlder: true,
  messages: [
    { kind: 'prompt', text: 'Synthetic prompt', at: NOW - 1000 },
    { kind: 'tool-calls', count: 3, names: ['Read', 'Edit', 'Bash'], at: NOW - 500 },
    { kind: 'reply', text: '## Synthetic reply\n\n**Done**', at: NOW }
  ]
}
function reply(cursor = 'reply'): NonNullable<Session['lastReply']> {
  return { cursor, completedAt: NOW, isError: false, errorCode: null, newerTurnStarted: false }
}
function mountDetail(change: Partial<Session> = {}, focused = true) {
  const fake = fakeApi()
  fake.api.getMessages.mockResolvedValue(exchange)
  const selected = session('detail', change)
  const props = {
    session: selected,
    api: fake.api,
    visible: true,
    focused,
    missing: false,
    confirmedAt: NOW
  }
  return { ...fake, props, ...render(<SessionDetail {...props} />) }
}

describe('session detail', () => {
  it('preserves the transcript scroll offset when a bounded-tail update shortens its scroll range', async () => {
    const f = mountDetail()
    await screen.findByText('Synthetic prompt')
    const region = screen.getByRole('region', { name: 'Recent messages' })
    const bottom = region.lastElementChild as HTMLElement
    let contentHeight = 500
    let scroll = 0
    Object.defineProperty(region, 'clientHeight', { value: 200 })
    Object.defineProperty(region, 'scrollHeight', {
      get: () => contentHeight + (parseFloat(bottom.style.height) || 0)
    })
    Object.defineProperty(region, 'scrollTop', {
      get: () => Math.min(scroll, region.scrollHeight - region.clientHeight),
      set: (value: number) => {
        scroll = Math.min(value, region.scrollHeight - region.clientHeight)
      }
    })
    region.scrollTop = 250
    fireEvent.scroll(region)
    contentHeight = 300
    f.api.getMessages.mockResolvedValue({ ...exchange, messages: [...exchange.messages] })
    f.rerender(
      <SessionDetail
        {...f.props}
        session={{
          ...f.props.session,
          summary: { ...f.props.session.summary, lastActivityAt: NOW }
        }}
      />
    )
    await vi.waitFor(() => expect(region.scrollTop).toBe(250))
    expect(parseFloat(bottom.style.height)).toBeGreaterThanOrEqual(150)
  })
  it.each([
    ['input needed', 'Claude Code asked you a question. Answer it in the Claude app.'],
    ['dialog open', 'Claude Code has a dialog open that needs you.'],
    ['sandbox request', 'Claude Code is asking to run something outside its sandbox.'],
    ['worker request', 'A Claude Code worker is waiting for your decision.'],
    ['goal proposal', 'Claude Code proposed a goal and is waiting for your answer.'],
    ['future value', 'Claude Code is waiting for you ("future value").']
  ])('shows the approved %s waiting explanation', async (waitingFor, text) => {
    mountDetail({ activity: { state: 'waiting', waitingFor } })
    expect(await screen.findByText(text)).toBeTruthy()
  })
  it.each([
    ['process-ended', /process for this session ended without reporting/],
    ['app-not-running', /Codex app isn't running/],
    ['quiet', /hasn't written anything for 30 minutes/],
    ['unreadable', /AgentPeek couldn't read this session's file/],
    ['unsupported', /writes this session in a format AgentPeek doesn't recognize/]
  ] as const)('shows the %s unknown explanation', async (reason, text) => {
    mountDetail({ activity: { state: 'unknown', reason } })
    expect(await screen.findByText(text)).toBeTruthy()
  })
  it('loads a bounded recent exchange, metadata, tool summaries and GFM', async () => {
    const f = mountDetail()
    expect(screen.getByRole('heading', { name: 'Synthetic detail' })).toBeTruthy()
    expect(screen.getByText('Loading messages…')).toBeTruthy()
    expect(await screen.findByText('Synthetic prompt')).toBeTruthy()
    expect(f.api.getMessages).toHaveBeenCalledWith({ tool: 'codex', id: 'detail' }, 20)
    expect(screen.getByText('Showing the last 3 messages')).toBeTruthy()
    expect(screen.getByText('Latest exchange')).toBeTruthy()
    expect(screen.getByText('3 tool calls · Read, Edit, Bash')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Synthetic reply' })).toBeTruthy()
    expect(screen.getByText('Codex · project').title).toBe('/synthetic/project')
    expect(screen.getByText(/Running · as of/)).toBeTruthy()
  })

  it('renders hostile Markdown inert and sends only safe links through the API', async () => {
    const f = mountDetail()
    const hostile =
      '<script>alert(1)</script>\n\n<img src="https://evil.invalid/a" onerror="alert(2)">\n\n' +
      '![synthetic alt](https://evil.invalid/image.png)\n\n' +
      '[bad](javascript:alert%281%29) [file](file:///tmp/a) [custom](codex:thread) [mail](mailto:x@y.invalid) ' +
      '[safe](https://example.com/path)\n\n| A | B |\n| - | - |\n| one | two |\n\n- [x] done\n\n~~removed~~'
    f.api.getMessages.mockResolvedValue({
      kind: 'messages',
      hasOlder: false,
      messages: [{ kind: 'reply', text: hostile, at: NOW }]
    })
    f.rerender(
      <SessionDetail
        {...f.props}
        session={{
          ...f.props.session,
          summary: { ...f.props.session.summary, lastActivityAt: NOW }
        }}
      />
    )
    expect(await screen.findByText('Image: synthetic alt')).toBeTruthy()
    const region = screen.getByRole('region', { name: 'Recent messages' })
    expect(
      region.querySelector('script,img,iframe,object,embed,video,audio,source,style,link')
    ).toBeNull()
    expect(region.textContent).toContain('<script>alert(1)</script>')
    expect(region.textContent).toContain('<img src=')
    expect(within(region).getAllByRole('link')).toHaveLength(1)
    expect(screen.getByRole('link', { name: 'safe' }).title).toBe('https://example.com/path')
    expect(screen.getByRole('table')).toBeTruthy()
    await userEvent.click(screen.getByRole('link', { name: 'safe' }))
    expect(f.api.openLink).toHaveBeenCalledWith('https://example.com/path')
  })

  it.each(['unreadable', 'not-found', 'rejection'] as const)(
    'retries a %s load without exposing the raw error',
    async (failure) => {
      const f = mountDetail()
      if (failure === 'rejection')
        f.api.getMessages.mockRejectedValueOnce(new Error('Synthetic private error'))
      else f.api.getMessages.mockResolvedValueOnce({ kind: failure })
      f.rerender(
        <SessionDetail
          {...f.props}
          session={{
            ...f.props.session,
            summary: { ...f.props.session.summary, lastActivityAt: NOW }
          }}
        />
      )
      await screen.findByText("Couldn't load messages")
      expect(screen.queryByText('Synthetic private error')).toBeNull()
      await userEvent.click(screen.getByRole('button', { name: 'Try Again' }))
      expect(await screen.findByText('Synthetic prompt')).toBeTruthy()
    }
  )

  it('caps previews at 6000 and expanded text at 200000 with explicit notices', async () => {
    const f = mountDetail()
    const text = 'x'.repeat(200_001)
    f.api.getMessages.mockResolvedValue({
      kind: 'messages',
      hasOlder: false,
      messages: [{ kind: 'reply', text, at: NOW }]
    })
    f.rerender(
      <SessionDetail
        {...f.props}
        session={{
          ...f.props.session,
          summary: { ...f.props.session.summary, lastActivityAt: NOW }
        }}
      />
    )
    await screen.findByText('Showing the first 6,000 of 200,001 characters.')
    expect(screen.getByText('x'.repeat(6000))).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Show Full Message' }))
    expect(screen.getByText('Showing the first 200,000 of 200,001 characters.')).toBeTruthy()
    expect(screen.getByText('Open Codex to read the rest.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Show Full Message' })).toBeNull()
  })

  it('marks only successfully loaded, visible, focused replies, and waits for focus on a new reply', async () => {
    const f = mountDetail(
      { lastReply: reply(), attention: { waiting: false, error: false, newReply: true } },
      false
    )
    await screen.findByText('Synthetic prompt')
    expect(f.api.markRead).not.toHaveBeenCalled()
    f.rerender(<SessionDetail {...f.props} focused />)
    await vi.waitFor(() =>
      expect(f.api.markRead).toHaveBeenCalledWith(f.props.session.key, 'reply')
    )
    f.rerender(
      <SessionDetail
        {...f.props}
        focused={false}
        session={{ ...f.props.session, lastReply: reply('next') }}
      />
    )
    await act(async () => {
      await Promise.resolve()
    })
    expect(f.api.markRead).toHaveBeenCalledTimes(1)
    f.rerender(
      <SessionDetail
        {...f.props}
        focused
        session={{ ...f.props.session, lastReply: reply('next') }}
      />
    )
    await vi.waitFor(() =>
      expect(f.api.markRead).toHaveBeenLastCalledWith(f.props.session.key, 'next')
    )
    expect(f.api.markRead).toHaveBeenCalledTimes(2)
  })

  it('does not mark unread messages on a failed load or clear waiting', async () => {
    const f = mountDetail(
      {
        activity: { state: 'waiting', waitingFor: 'permission prompt' },
        attention: { waiting: true, newReply: true, error: false },
        lastReply: reply()
      },
      false
    )
    f.api.getMessages.mockResolvedValueOnce({ kind: 'unreadable' })
    f.rerender(
      <SessionDetail
        {...f.props}
        focused
        session={{
          ...f.props.session,
          summary: { ...f.props.session.summary, lastActivityAt: NOW }
        }}
      />
    )
    await screen.findByText("Couldn't load messages")
    expect(f.api.markRead).not.toHaveBeenCalled()
    expect(
      screen.getByText(
        'Claude Code is asking for permission to use a tool. Answer it in the Claude app.'
      )
    ).toBeTruthy()
  })

  it('keeps an acknowledged error visible with its quoted detail and Claude terminal copy', async () => {
    const f = mountDetail({
      lastReply: { ...reply(), isError: true, errorCode: 'server_overloaded' }
    })
    f.api.getMessages.mockResolvedValue({
      ...exchange,
      kind: 'messages',
      messages: [],
      hasOlder: false,
      error: { cursor: 'reply', message: 'Synthetic error text.' }
    })
    f.rerender(
      <SessionDetail
        {...f.props}
        session={{
          ...f.props.session,
          summary: { ...f.props.session.summary, lastActivityAt: NOW }
        }}
      />
    )
    expect(await screen.findByText(/Synthetic error text\./)).toBeTruthy()
    expect(screen.getByText('Codex ended the turn with an error.')).toBeTruthy()
    f.rerender(
      <SessionDetail
        {...f.props}
        session={{
          ...f.props.session,
          key: { tool: 'claude', id: 'detail' },
          lastReply: { ...reply(), isError: true, errorCode: 'rate_limit' }
        }}
      />
    )
    expect(
      await screen.findByText('No final reply: the turn ended with an API error.')
    ).toBeTruthy()
  })

  it.each(['codex', 'claude'] as const)(
    'dispatches %s header actions and reports failures',
    async (tool) => {
      const f = mountDetail(
        {
          key: { tool, id: 'exact-synthetic-id' },
          attention: { waiting: false, newReply: true, error: false }
        },
        false
      )
      await screen.findByText('Synthetic prompt')
      await userEvent.click(
        screen.getByRole('button', { name: tool === 'codex' ? 'Open Codex' : 'Open Claude' })
      )
      expect(f.api.openTool).toHaveBeenCalledWith(tool)
      await userEvent.click(screen.getByRole('button', { name: 'Copy Session ID' }))
      expect(f.api.copySessionId).toHaveBeenCalledWith({ tool, id: 'exact-synthetic-id' })
      await userEvent.click(screen.getByRole('button', { name: 'Pin' }))
      expect(f.api.setPinned).toHaveBeenCalledWith({ tool, id: 'exact-synthetic-id' }, true)
      await userEvent.click(screen.getByRole('button', { name: 'Mark Read' }))
      expect(f.api.markRead).toHaveBeenCalledWith({ tool, id: 'exact-synthetic-id' })
      f.api.copySessionId.mockResolvedValueOnce(false)
      await userEvent.click(screen.getByRole('button', { name: 'Copy Session ID' }))
      expect(screen.getByRole('status').textContent).toBe("Couldn't copy the session ID.")
    }
  )
})

describe('detail navigation and request lifetime', () => {
  it('switches responsive visibility immediately at the width breakpoint', async () => {
    const media = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }
    vi.spyOn(window, 'matchMedia').mockReturnValue(media as unknown as MediaQueryList)
    const fake = fakeApi(snapshot([session('a')]))
    Object.defineProperty(window, 'agentpeek', { value: fake.api, configurable: true })
    const store = createSessionsStore(fake.api)
    render(<App store={store} />)
    await userEvent.click(await screen.findByRole('option'))
    expect(screen.getByRole('complementary', { name: 'Session detail' })).toBeTruthy()
    const listener = media.addEventListener.mock.calls[0]?.[1] as () => void
    act(() => {
      media.matches = true
      listener()
    })
    expect(screen.queryByRole('complementary', { name: 'Session detail' })).toBeNull()
    act(() => {
      media.matches = false
      listener()
    })
    expect(screen.getByRole('complementary', { name: 'Session detail' })).toBeTruthy()
  })
  function mountApp(narrow = false) {
    vi.spyOn(window, 'matchMedia').mockReturnValue({
      matches: narrow,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    } as unknown as MediaQueryList)
    const fake = fakeApi(snapshot([session('a'), session('b')]))
    Object.defineProperty(window, 'agentpeek', { value: fake.api, configurable: true })
    const store = createSessionsStore(fake.api)
    return { ...fake, store, ...render(<App store={store} />) }
  }

  it('ignores a late response after switching sessions', async () => {
    const f = mountApp()
    let finish!: (r: RecentMessages) => void
    f.api.getMessages.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    await userEvent.click(await screen.findByRole('option', { name: /Synthetic a/ }))
    f.api.getMessages.mockResolvedValue(exchange)
    await userEvent.click(screen.getByRole('option', { name: /Synthetic b/ }))
    await screen.findByText('Synthetic prompt')
    await act(async () => {
      finish({
        kind: 'messages',
        hasOlder: false,
        messages: [{ kind: 'reply', text: 'Stale synthetic response', at: NOW }]
      })
      await Promise.resolve()
    })
    expect(screen.queryByText('Stale synthetic response')).toBeNull()
  })

  it('narrow arrows select without loading; Enter/click push detail and every Back path restores the selected row', async () => {
    const f = mountApp(true)
    await screen.findByRole('option', { name: /Synthetic a/ })
    const list = screen.getByRole('listbox')
    list.focus()
    await userEvent.keyboard('{ArrowDown}')
    expect(f.api.getMessages).not.toHaveBeenCalled()
    expect(f.api.markRead).not.toHaveBeenCalled()
    for (const back of ['button', 'escape', 'menu']) {
      await userEvent.keyboard('{Enter}')
      await screen.findByRole('region', { name: 'Recent messages' })
      expect(f.api.setDetailOpen).toHaveBeenLastCalledWith(true)
      expect(screen.queryByRole('listbox')).toBeNull()
      if (back === 'button') await userEvent.click(screen.getByRole('button', { name: '‹ Active' }))
      if (back === 'escape') await userEvent.keyboard('{Escape}')
      if (back === 'menu') act(() => f.command('back'))
      expect(document.activeElement).toBe(list)
      expect(list.getAttribute('aria-activedescendant')).toBe('session-codex:a')
      expect(f.api.setDetailOpen).toHaveBeenLastCalledWith(false)
    }
    await userEvent.click(screen.getByRole('option', { name: /Synthetic b/ }))
    expect(screen.getByRole('button', { name: '‹ Active' })).toBeTruthy()
    fireEvent.blur(window)
  })
})
