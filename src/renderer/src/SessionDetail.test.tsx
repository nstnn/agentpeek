import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { RecentMessages, Session } from '../../core/session'
import { fakeApi, NOW, session, snapshot } from '../test-support'
import { SessionDetail } from './SessionDetail'
import { App } from './App'
import { mockWorkspaceWidth } from '../workspace-test-support'
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
    canAutoRead: () => true,
    missing: false,
    lastSeenAt: NOW,
    sourceEpoch: 0,
    reloadPending: false,
    reloadVersion: 0,
    onReload: fake.api.reload
  }
  return { ...fake, props, ...render(<SessionDetail {...props} />) }
}

describe('session detail', () => {
  it('preserves scroll after width reflow and ignores hidden scroll events', async () => {
    let resize!: () => void
    vi.spyOn(window, 'ResizeObserver').mockImplementation(
      class {
        constructor(callback: ResizeObserverCallback) {
          this.observe = (element: Element) => {
            if (element.classList.contains('transcript')) resize = () => callback([], this)
          }
        }
        observe: (element: Element) => void
        unobserve = vi.fn()
        disconnect = vi.fn()
      }
    )
    const f = mountDetail()
    await screen.findByText('Synthetic prompt')
    const region = screen.getByRole('region')
    const bottom = region.lastElementChild as HTMLElement
    let contentHeight = 600
    let width = 400
    let scroll = 0
    Object.defineProperty(region, 'clientHeight', { value: 200 })
    Object.defineProperty(region, 'clientWidth', { get: () => width })
    Object.defineProperty(region, 'scrollHeight', {
      get: () => contentHeight + (parseFloat(bottom.style.height) || 0)
    })
    Object.defineProperty(region, 'scrollTop', {
      get: () => Math.min(scroll, region.scrollHeight - region.clientHeight),
      set: (value: number) => {
        scroll = value
      }
    })
    act(resize)
    region.scrollTop = 350
    fireEvent.scroll(region)
    contentHeight = 250
    width = 800
    fireEvent.scroll(region)
    act(resize)
    fireEvent.scroll(region)
    expect(region.scrollTop).toBe(350)
    f.rerender(<SessionDetail {...f.props} visible={false} />)
    fireEvent.scroll(region, { target: { scrollTop: 0 } })
    f.rerender(<SessionDetail {...f.props} visible />)
    expect(region.scrollTop).toBe(350)
  })
  it('keeps loaded inactive/unsynchronized content unread until its activation is eligible', async () => {
    const f = mountDetail({
      lastReply: reply(),
      attention: { waiting: false, error: false, newReply: true }
    })
    const eligible = vi.fn(() => false)
    f.rerender(<SessionDetail {...f.props} canAutoRead={eligible} />)
    await screen.findByText('Synthetic prompt')
    expect(f.api.markRead).not.toHaveBeenCalled()
    eligible.mockReturnValue(true)
    f.rerender(<SessionDetail {...f.props} canAutoRead={() => eligible()} />)
    await vi.waitFor(() =>
      expect(f.api.markRead).toHaveBeenCalledWith(f.props.session.key, 'reply')
    )
  })
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
    expect(screen.getByText(/^Running$/)).toBeTruthy()
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

  it.each(['unreadable', 'rejection'] as const)(
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

  it.each([5999, 6000, 6001, 199999, 200000, 200001, 211200])(
    'keeps truthful, reversible message disclosure at %i characters',
    async (length) => {
      const f = mountDetail()
      const text = 'x'.repeat(length)
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
      const region = await screen.findByRole('region', { name: 'Recent messages' })
      await vi.waitFor(() => expect(region.querySelector('.markdown')).toBeTruthy())
      expect(region.querySelector('.markdown')?.textContent?.length).toBe(Math.min(length, 6000))
      if (length <= 6000) {
        expect(screen.queryByRole('button', { name: 'Show More' })).toBeNull()
        expect(region.querySelector('.truncation-notice')).toBeNull()
        return
      }
      const toggle = screen.getByRole('button', { name: 'Show More' })
      const controlled = document.getElementById(toggle.getAttribute('aria-controls')!)
      expect(controlled?.textContent?.length).toBe(6000)
      expect(toggle.getAttribute('aria-expanded')).toBe('false')
      expect(region.textContent).toContain(
        `Showing the first 6,000 of ${length.toLocaleString('en-US')} characters.`
      )
      expect(region.textContent?.includes('Expansion is limited to 200,000')).toBe(length > 200000)
      expect(region.textContent?.includes('Open Codex to read the rest.')).toBe(length > 200000)
      toggle.focus()
      await userEvent.keyboard('{Enter}')
      expect(screen.getByRole('button', { name: 'Collapse Message' })).toBe(toggle)
      expect(document.activeElement).toBe(toggle)
      expect(toggle.getAttribute('aria-expanded')).toBe('true')
      expect(document.getElementById(toggle.getAttribute('aria-controls')!)).toBe(controlled)
      expect(controlled?.textContent?.length).toBe(Math.min(length, 200000))
      expect(region.textContent).toContain(
        length > 200000
          ? `Showing the first 200,000 of ${length.toLocaleString('en-US')} characters.`
          : `Showing all ${length.toLocaleString('en-US')} characters.`
      )
      await userEvent.click(screen.getByRole('button', { name: 'Back to Message Start' }))
      expect(document.activeElement).toBe(toggle)
      await userEvent.keyboard(' ')
      expect(screen.getByRole('button', { name: 'Show More' })).toBe(toggle)
      expect(document.activeElement).toBe(toggle)
      expect(controlled?.textContent?.length).toBe(6000)
    }
  )

  it('returns to the message start after a late keyboard scroll, without overriding new input', async () => {
    const f = mountDetail()
    f.api.getMessages.mockResolvedValue({
      kind: 'messages',
      hasOlder: false,
      messages: [{ kind: 'reply', text: 'Synthetic long reply. '.repeat(400), at: NOW }]
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
    const toggle = await screen.findByRole('button', { name: 'Show More' })
    const region = screen.getByRole('region', { name: 'Recent messages' })
    const message = toggle.closest('.message-text')!
    vi.spyOn(region, 'getBoundingClientRect').mockImplementation(
      () => new DOMRect(0, 100, 400, 300)
    )
    vi.spyOn(message, 'getBoundingClientRect').mockImplementation(
      () => new DOMRect(0, 500 - region.scrollTop, 400, 2000)
    )
    vi.useFakeTimers()
    try {
      fireEvent.click(toggle)
      region.scrollTop = 3000
      fireEvent.scroll(region)
      fireEvent.click(toggle)
      expect(region.scrollTop).toBe(392)
      region.scrollTop = 1200
      fireEvent.scroll(region)
      act(() => {
        vi.advanceTimersByTime(150)
      })
      expect(region.scrollTop).toBe(392)
      fireEvent.click(toggle)
      region.scrollTop = 900
      fireEvent.scroll(region)
      fireEvent.wheel(region)
      act(() => {
        vi.advanceTimersByTime(150)
      })
      expect(region.scrollTop).toBe(900)
    } finally {
      f.unmount()
      vi.useRealTimers()
    }
  })

  it('preserves independent message disclosures across live updates', async () => {
    const f = mountDetail()
    const messages = [
      { kind: 'prompt' as const, text: 'p'.repeat(6001), at: NOW - 1000 },
      { kind: 'reply' as const, text: 'r'.repeat(6001), at: NOW }
    ]
    f.api.getMessages.mockResolvedValue({
      kind: 'messages',
      hasOlder: false,
      messages
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
    const toggles = await screen.findAllByRole('button', { name: 'Show More' })
    await userEvent.click(toggles[0]!)
    expect(screen.getAllByRole('button', { name: 'Show More' })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: 'Collapse Message' })).toHaveLength(1)
    f.api.getMessages.mockResolvedValue({
      kind: 'messages',
      hasOlder: false,
      messages: messages.map((message) => ({ ...message, text: message.text + ' live' }))
    })
    f.rerender(
      <SessionDetail
        {...f.props}
        session={{
          ...f.props.session,
          summary: { ...f.props.session.summary, lastActivityAt: NOW + 1000 }
        }}
      />
    )
    await screen.findByText('Showing all 6,006 characters.')
    expect(screen.getByRole('button', { name: 'Collapse Message' })).toBe(toggles[0])
    expect(document.activeElement).toBe(toggles[0])
    expect(screen.getByRole('button', { name: 'Show More' })).toBe(toggles[1])
    await userEvent.click(toggles[1]!)
    await userEvent.click(toggles[0]!)
    expect(screen.getByRole('button', { name: 'Collapse Message' })).toBe(toggles[1])
  })

  it.each([0, 1])(
    'keeps disclosure on its own timestamp sibling when the tail drops a message (expanded %i)',
    async (expandedIndex) => {
      const f = mountDetail()
      const first = { kind: 'reply' as const, text: 'A'.repeat(7000), at: NOW }
      const surviving = { kind: 'reply' as const, text: 'B'.repeat(7000), at: NOW }
      f.api.getMessages.mockResolvedValue({
        kind: 'messages',
        hasOlder: false,
        messages: [first, surviving]
      })
      const update = (at: number) =>
        f.rerender(
          <SessionDetail
            {...f.props}
            session={{
              ...f.props.session,
              summary: { ...f.props.session.summary, lastActivityAt: at }
            }}
          />
        )
      update(NOW)
      const controls = await screen.findAllByRole('button', { name: 'Show More' })
      await userEvent.click(controls[expandedIndex]!)
      const survivorId = controls[1]!.getAttribute('aria-controls')
      f.api.getMessages.mockResolvedValue({
        kind: 'messages',
        hasOlder: true,
        messages: [surviving, { kind: 'reply', text: 'C'.repeat(7000), at: NOW + 1 }]
      })
      update(NOW + 1)
      await screen.findByText('C'.repeat(6000))
      const survivorText = document.getElementById(survivorId!)!
      expect(survivorText.textContent?.length).toBe(expandedIndex === 1 ? 7000 : 6000)
      const article = survivorText.closest('article')!
      expect(
        within(article).getByRole('button', {
          name: expandedIndex === 1 ? 'Collapse Message' : 'Show More'
        })
      ).toBe(controls[1])
      if (expandedIndex === 1) expect(document.activeElement).toBe(controls[1])
      expect(screen.getByText('C'.repeat(6000))).toBeTruthy()
    }
  )

  it('keeps the original disclosure and focus when an identical timestamp sibling is appended', async () => {
    const f = mountDetail()
    const message = {
      kind: 'reply' as const,
      text: 'Repeated synthetic reply. '.repeat(300),
      at: NOW
    }
    f.api.getMessages.mockResolvedValue({ kind: 'messages', hasOlder: false, messages: [message] })
    const update = (at: number) =>
      f.rerender(
        <SessionDetail
          {...f.props}
          session={{
            ...f.props.session,
            summary: { ...f.props.session.summary, lastActivityAt: at }
          }}
        />
      )
    update(NOW)
    const toggle = await screen.findByRole('button', { name: 'Show More' })
    await userEvent.click(toggle)
    const original = toggle.closest('article')
    f.api.getMessages.mockResolvedValue({
      kind: 'messages',
      hasOlder: false,
      messages: [message, { ...message }]
    })
    update(NOW + 1)
    await screen.findByRole('button', { name: 'Show More' })
    const articles = screen
      .getByRole('region', { name: 'Recent messages' })
      .querySelectorAll('article')
    expect(articles[0]).toBe(original)
    expect(within(articles[0]!).getByRole('button', { name: 'Collapse Message' })).toBe(toggle)
    expect(within(articles[1]!).getByRole('button', { name: 'Show More' })).toBeTruthy()
    expect(document.activeElement).toBe(toggle)
    f.api.getMessages.mockResolvedValue({
      kind: 'messages',
      hasOlder: true,
      messages: [{ ...message }]
    })
    update(NOW + 2)
    await vi.waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Collapse Message' })).toBeNull()
    )
    expect(screen.getByRole('button', { name: 'Show More' })).toBeTruthy()
  })

  it('recomputes title disclosure on resize and title replacement while retaining its accessible heading', async () => {
    let notify!: () => void
    vi.spyOn(window, 'ResizeObserver').mockImplementation(
      class {
        constructor(callback: ResizeObserverCallback) {
          this.observe = (element: Element) => {
            if (element.tagName === 'H2') notify = () => callback([], this)
          }
        }
        observe: (element: Element) => void
        unobserve = vi.fn()
        disconnect = vi.fn()
      }
    )
    const f = mountDetail()
    const heading = screen.getByRole('heading', { name: 'Synthetic detail' })
    expect(screen.queryByRole('button', { name: 'Show Full Title' })).toBeNull()
    heading.style.lineHeight = '22px'
    let height = 110
    Object.defineProperty(heading, 'scrollHeight', { get: () => height })
    act(notify)
    const toggle = screen.getByRole('button', { name: 'Show Full Title' })
    expect(toggle.getAttribute('aria-controls')).toBe(heading.id)
    toggle.focus()
    await userEvent.keyboard('{Enter}')
    expect(screen.getByRole('button', { name: 'Show Less Title' })).toBe(toggle)
    expect(document.activeElement).toBe(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    await userEvent.keyboard(' ')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    await userEvent.keyboard('{Enter}')
    f.container.hidden = true
    height = 0
    act(notify)
    f.container.hidden = false
    height = 44
    act(notify)
    expect(screen.queryByRole('button', { name: 'Show Less Title' })).toBeNull()
    height = 110
    act(notify)
    expect(
      screen.getByRole('button', { name: 'Show Less Title' }).getAttribute('aria-expanded')
    ).toBe('true')
    await userEvent.click(screen.getByRole('button', { name: 'Show Less Title' }))
    height = 44
    act(notify)
    expect(screen.queryByRole('button', { name: 'Show Full Title' })).toBeNull()
    expect(document.activeElement).toBe(heading)
    f.rerender(
      <SessionDetail
        {...f.props}
        session={{ ...f.props.session, summary: { ...f.props.session.summary, title: 'Updated' } }}
      />
    )
    expect(screen.getByRole('heading', { name: 'Updated' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Show Full Title' })).toBeNull()
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
      expect(f.api.openTool).toHaveBeenCalledWith({ tool, id: 'exact-synthetic-id' })
      await userEvent.click(screen.getByRole('button', { name: 'Pin' }))
      expect(f.api.setPinned).toHaveBeenCalledWith({ tool, id: 'exact-synthetic-id' }, true)
      await userEvent.click(screen.getByRole('button', { name: 'Mark Read' }))
      expect(f.api.markRead).toHaveBeenCalledWith({ tool, id: 'exact-synthetic-id' })
      f.api.openTool.mockResolvedValueOnce(false)
      await userEvent.click(
        screen.getByRole('button', { name: tool === 'codex' ? 'Open Codex' : 'Open Claude' })
      )
      expect(screen.getByRole('status').textContent).toBe(
        `Couldn't open ${tool === 'codex' ? 'Codex' : 'Claude Code'}.`
      )
    }
  )
})

describe('detail navigation and request lifetime', () => {
  it('keeps the reading target while resizing through replacement navigation', async () => {
    const resize = mockWorkspaceWidth(1100)
    const fake = fakeApi(snapshot([session('a')]))
    Object.defineProperty(window, 'agentpeek', { value: fake.api, configurable: true })
    const store = createSessionsStore(fake.api)
    store.setGrouping('status')
    render(<App store={store} />)
    await userEvent.click(await screen.findByRole('option'))
    expect(screen.getByRole('complementary', { name: 'Session detail' })).toBeTruthy()
    resize(760)
    expect(screen.getByRole('complementary', { name: 'Session detail' })).toBeTruthy()
    expect(screen.queryByRole('listbox')).toBeNull()
    resize(1100)
    expect(screen.getByRole('complementary', { name: 'Session detail' })).toBeTruthy()
    expect(screen.getByRole('listbox')).toBeTruthy()
  })
  function mountApp(narrow = false) {
    mockWorkspaceWidth(narrow ? 760 : 1100)
    const fake = fakeApi(snapshot([session('a'), session('b')]))
    Object.defineProperty(window, 'agentpeek', { value: fake.api, configurable: true })
    const store = createSessionsStore(fake.api)
    store.setGrouping('status')
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

  it('resets message disclosure when selecting a different session and returning', async () => {
    const f = mountApp()
    f.api.getMessages.mockResolvedValue({
      kind: 'messages',
      hasOlder: false,
      messages: [{ kind: 'reply', text: 'Synthetic long message. '.repeat(300), at: NOW }]
    })
    await userEvent.click(await screen.findByRole('option', { name: /Synthetic a/ }))
    await userEvent.click(await screen.findByRole('button', { name: 'Show More' }))
    expect(screen.getByRole('button', { name: 'Collapse Message' })).toBeTruthy()
    await userEvent.click(screen.getByRole('option', { name: /Synthetic b/ }))
    expect(await screen.findByRole('button', { name: 'Show More' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Collapse Message' })).toBeNull()
    await userEvent.click(screen.getByRole('option', { name: /Synthetic a/ }))
    expect(await screen.findByRole('button', { name: 'Show More' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Collapse Message' })).toBeNull()
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
      if (back === 'button')
        await userEvent.click(screen.getByRole('button', { name: 'Show Sessions' }))
      if (back === 'escape') await userEvent.keyboard('{Escape}')
      if (back === 'menu') act(() => f.command('back'))
      expect(document.activeElement).toBe(list)
      expect(list.getAttribute('aria-activedescendant')).toBe('session-codex:a')
      expect(f.api.setDetailOpen).toHaveBeenLastCalledWith(false)
    }
    await userEvent.click(screen.getByRole('option', { name: /Synthetic b/ }))
    expect(screen.getByRole('button', { name: 'Show Sessions' })).toBeTruthy()
    fireEvent.blur(window)
  })
})
