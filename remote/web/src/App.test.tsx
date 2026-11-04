import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import type { StatusFrame } from '../../../src/core/remote/protocol'
import { VALID_STATUS_FRAME } from '../../../src/core/remote/protocol-vectors'
import type { RemoteSession } from '../../../src/core/remote/status-projection'
import { App } from './App'

// The page with a scripted Mac; the browser-level runs are in remote/web/browser.

afterEach(cleanup)

const settle = () => act(() => new Promise((done) => setTimeout(done, 10)))

/** A stream that sends `text` and stays open, as the Mac's does. */
function openStream(text: string): Response {
  const body = new ReadableStream<Uint8Array>({
    start: (controller) => controller.enqueue(new TextEncoder().encode(text))
  })
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } })
}

function stream(text: string): typeof fetch {
  return () => Promise.resolve(openStream(text))
}

function refuse(error: string, status: number): typeof fetch {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify({ v: 2, error }), {
        status,
        headers: { 'Content-Type': 'application/json' }
      })
    )
}

it('shows Connecting until the first status, then Live with the shared projects', async () => {
  let release: (response: Response) => void = () => undefined
  const fetch = (() => new Promise<Response>((done) => (release = done))) as typeof globalThis.fetch
  render(<App fetch={fetch} />)
  expect(screen.getByRole('heading', { level: 1, name: 'AgentPeek' })).toBeTruthy()
  expect(screen.getByRole('status').textContent).toBe('Connecting…')
  release(openStream(`event: status\ndata: ${JSON.stringify(VALID_STATUS_FRAME)}\n\n`))
  await settle()
  expect(screen.getByRole('status').textContent).toBe('Live')
  // The Active view, grouped by status like the desktop: the waiting session's group.
  expect(screen.getByRole('heading', { level: 2, name: /^Waiting for you/ })).toBeTruthy()
})

it('shows Not allowed with no data and no button', async () => {
  render(<App fetch={refuse('not-allowed', 403)} />)
  await settle()
  expect(
    screen.getByText(
      'Not allowed. This page only opens for the Tailscale login set in AgentPeek on the Mac.'
    )
  ).toBeTruthy()
  expect(screen.queryByTestId('status')).toBeNull()
  // Only the menu button: no Retry, no row and no view count.
  expect(screen.getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual(
    expect.arrayContaining(['Show views'])
  )
  expect(document.querySelectorAll('.rows li, .sources li, .badge, .count')).toHaveLength(0)
})

it('shows the wrong-address state for bad-host', async () => {
  render(<App fetch={refuse('bad-host', 421)} />)
  await settle()
  expect(screen.getByText('Open this page with the Mac address set in AgentPeek.')).toBeTruthy()
})

it('asks for a reload when the versions differ', async () => {
  render(<App fetch={refuse('unsupported-version', 404)} />)
  await settle()
  expect(screen.getByRole('status').textContent).toBe('Update needed')
  expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy()
})

it('shows Too many open pages with Retry for busy', async () => {
  render(<App fetch={refuse('busy', 503)} />)
  await settle()
  expect(screen.getByRole('status').textContent).toBe('Too many open pages')
  expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
})

it('shows the waiting session in its group, with the summary, view counts and sources', async () => {
  render(<App fetch={stream(`event: status\ndata: ${JSON.stringify(VALID_STATUS_FRAME)}\n\n`)} />)
  await settle()
  const waiting = screen.getByRole('region', { name: /^Waiting for you/ })
  expect(within(waiting).getByRole('listitem').textContent).toBe(
    'Session 1, Claude Code · synthetic-project, Waiting for you · Permission'
  )
  expect(screen.getByText('1 need attention · 0 running · 0 unknown')).toBeTruthy()
  expect(screen.getByRole('button', { name: /^Active/ }).textContent).toBe('Active1')
  expect(screen.getByText('Claude Code: no access on the Mac.')).toBeTruthy()
  expect(
    within(screen.getByRole('list', { name: 'Sources on the Mac' })).getAllByRole('listitem')
  ).toHaveLength(2)
})

it('says when nothing is shared', async () => {
  const empty = { ...VALID_STATUS_FRAME, status: { ...VALID_STATUS_FRAME.status, projects: [] } }
  render(<App fetch={stream(`event: status\ndata: ${JSON.stringify(empty)}\n\n`)} />)
  await settle()
  expect(screen.getByText(/No projects are shared\./)).toBeTruthy()
})

// Synthetic rows for the list tests: aliases, invented folders and IDs.
const T = VALID_STATUS_FRAME.sentAt
const row = (id: string, change: Partial<RemoteSession> = {}): RemoteSession => ({
  id: id.padEnd(22, 'A'),
  tool: 'codex',
  title: `Session ${id}`,
  activity: { state: 'running' },
  attention: { waiting: false, newReply: false, error: false },
  attentionSince: null,
  lastActivityAt: T - 2 * 60_000,
  ...change
})

function frame(
  snapshotId: string,
  projects: StatusFrame['status']['projects'],
  sentAt = T
): StatusFrame {
  return {
    ...VALID_STATUS_FRAME,
    snapshotId,
    sentAt,
    status: {
      ...VALID_STATUS_FRAME.status,
      sources: {
        codex: { state: 'connected', lastReadAt: T },
        claude: { state: 'connected', lastReadAt: T }
      },
      projects
    }
  }
}

const event = (value: object) =>
  `event: ${(value as { type: string }).type}\ndata: ${JSON.stringify(value)}\n\n`

/** A stream the test writes to frame by frame, and every request the page made. */
function scripted() {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const requests: string[] = []
  const fetch = ((input: string, init?: RequestInit) => {
    requests.push(`${init?.method ?? 'GET'} ${input}`)
    const body = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) })
    return Promise.resolve(
      new Response(body, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } })
    )
  }) as typeof globalThis.fetch
  const send = async (value: object) => {
    controller.enqueue(new TextEncoder().encode(event(value)))
    await settle()
  }
  return { fetch, requests, send }
}

const rowTexts = () => [...document.querySelectorAll('.rows > li')].map((item) => item.textContent)
const choose = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }))

it('replaces every row on each status, with no duplicate or stale rows', async () => {
  const mac = scripted()
  render(<App fetch={mac.fetch} />)
  await settle()
  await mac.send(
    frame('s1', [{ label: 'alpha', sessions: [row('a'), row('b', { tool: 'claude' })] }])
  )
  choose(/^All Sessions/)
  expect(rowTexts()).toEqual([
    'Session a, Codex · alpha, Running, 2 min ago',
    'Session b, Claude Code · alpha, Running, 2 min ago'
  ])

  // "a" now has a new reply, "b" is gone, "c" is new.
  await mac.send(
    frame(
      's2',
      [
        {
          label: 'alpha',
          sessions: [
            row('c', { activity: { state: 'idle' } }),
            row('a', {
              activity: { state: 'idle' },
              attention: { waiting: false, newReply: true, error: false },
              attentionSince: T + 1000 - 4 * 60_000
            })
          ]
        }
      ],
      T + 1000
    )
  )
  expect(rowTexts()).toEqual([
    'Session a, Codex · alpha, New reply, for 4 min',
    'Session c, Codex · alpha, Idle, 2 min ago'
  ])
  expect(screen.getAllByText(/Session a/)).toHaveLength(1)
  expect(screen.queryByText(/Session b/)).toBeNull()
  expect(screen.getByText('1 need attention · 0 running · 0 unknown')).toBeTruthy()
})

it('switches views, grouping and tool as page state only, sending nothing to the Mac', async () => {
  const mac = scripted()
  render(<App fetch={mac.fetch} />)
  await settle()
  await mac.send(
    frame('s1', [
      { label: 'alpha', sessions: [row('a'), row('b', { tool: 'claude' })] },
      { label: 'beta', sessions: [row('c', { activity: { state: 'idle' } })] }
    ])
  )
  const history = window.history.length
  const location = window.location.href

  // Active hides the idle session; All Sessions shows it.
  expect(rowTexts()).toHaveLength(2)
  expect(screen.getByRole('button', { name: /^All Sessions/ }).textContent).toBe('All Sessions3')
  choose(/^All Sessions/)
  expect(rowTexts()).toHaveLength(3)
  expect(screen.getByText('All Sessions', { selector: '.view-title' })).toBeTruthy()

  choose('Project')
  expect(screen.getByRole('heading', { level: 2, name: /^alpha/ })).toBeTruthy()
  expect(screen.getByRole('heading', { level: 2, name: /^beta/ })).toBeTruthy()

  choose('Claude Code, 1')
  expect(rowTexts()).toEqual(['Session b, Claude Code · alpha, Running, 2 min ago'])
  expect(screen.queryByRole('heading', { name: /^beta/ })).toBeNull()

  // A tool with no session in the view says so and offers Show all.
  choose(/^Active/)
  await mac.send(frame('s2', [{ label: 'alpha', sessions: [row('a')] }]))
  expect(screen.getByText('No sessions match this filter.')).toBeTruthy()
  choose('Show all')
  expect(rowTexts()).toEqual(['Session a, Codex · alpha, Running, 2 min ago'])

  expect(mac.requests).toEqual(['GET /v2/status'])
  expect(window.history.length).toBe(history)
  expect(window.location.href).toBe(location)
})

it('opens the views from the menu button and closes them on a choice or Escape', async () => {
  const mac = scripted()
  render(<App fetch={mac.fetch} />)
  await settle()
  await mac.send(frame('s1', [{ label: 'alpha', sessions: [row('a')] }]))
  const menu = screen.getByRole('button', { name: 'Show views' })
  fireEvent.click(menu)
  expect(menu.getAttribute('aria-expanded')).toBe('true')
  expect(document.activeElement?.textContent).toBe('Active')
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(menu.getAttribute('aria-expanded')).toBe('false')
  expect(document.activeElement).toBe(menu)
  fireEvent.click(menu)
  choose(/^All Sessions/)
  expect(menu.getAttribute('aria-expanded')).toBe('false')
  expect(screen.getByText('All Sessions', { selector: '.view-title' })).toBeTruthy()
})

it('moves live ages on with the local clock between frames', async () => {
  let local = 1_000
  const mac = scripted()
  render(<App fetch={mac.fetch} now={() => local} tickMs={20} />)
  await settle()
  await mac.send(frame('s1', [{ label: 'alpha', sessions: [row('a')] }]))
  expect(rowTexts()).toEqual(['Session a, Codex · alpha, Running, 2 min ago'])
  local += 3 * 60_000
  await act(() => new Promise((done) => setTimeout(done, 50)))
  expect(rowTexts()).toEqual(['Session a, Codex · alpha, Running, 5 min ago'])
})

it('keeps the list on a heartbeat and moves only the checked time', async () => {
  const mac = scripted()
  render(<App fetch={mac.fetch} />)
  await settle()
  const first = frame('s1', [{ label: 'alpha', sessions: [row('a')] }])
  await mac.send(first)
  await mac.send({
    v: 2,
    type: 'heartbeat',
    snapshotId: 's1',
    generation: first.generation,
    sentAt: T + 3 * 60_000
  })
  expect(rowTexts()).toEqual(['Session a, Codex · alpha, Running, 5 min ago'])
})

it('clears the list and asks for a reload when a frame has another version', async () => {
  const mac = scripted()
  render(<App fetch={mac.fetch} />)
  await settle()
  await mac.send(frame('s1', [{ label: 'alpha', sessions: [row('a')] }]))
  await mac.send({ ...frame('s2', []), v: 3 })
  expect(screen.getByRole('status').textContent).toBe('Update needed')
  expect(screen.queryByTestId('status')).toBeNull()
  expect(screen.queryByText(/Session a/)).toBeNull()
  expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy()
})

it('says nothing needs you in Active, and no sessions in an empty All Sessions', async () => {
  const mac = scripted()
  render(<App fetch={mac.fetch} />)
  await settle()
  await mac.send(
    frame('s1', [
      { label: 'alpha', sessions: [row('a', { activity: { state: 'idle' } })] },
      { label: 'beta', sessions: [] }
    ])
  )
  expect(screen.getByText('Nothing needs you right now.')).toBeTruthy()
  await mac.send(frame('s2', [{ label: 'beta', sessions: [] }]))
  choose(/^All Sessions/)
  expect(screen.getByText('No sessions.')).toBeTruthy()
})

it('clears the list when access changes and the next request is not allowed', async () => {
  const replies = [
    () =>
      openStream(
        event(frame('s1', [{ label: 'alpha', sessions: [row('a')] }])) +
          event({ v: 2, type: 'end', reason: 'access-changed' })
      ),
    () =>
      new Response(JSON.stringify({ v: 2, error: 'not-allowed' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      })
  ]
  const fetch = (() => Promise.resolve(replies.shift()!())) as typeof globalThis.fetch
  render(<App fetch={fetch} random={() => 0} />)
  await settle()
  await settle()
  expect(replies).toHaveLength(0)
  expect(
    screen.getByText(
      'Not allowed. This page only opens for the Tailscale login set in AgentPeek on the Mac.'
    )
  ).toBeTruthy()
  expect(screen.queryByTestId('status')).toBeNull()
  expect(screen.queryByText(/Session a/)).toBeNull()
  expect(screen.queryByRole('listitem')).toBeNull()
})

it('shows last change separately from listener checked time, and dims until a full snapshot after page resume', async () => {
  const h = scripted()
  render(<App fetch={h.fetch} />)
  await settle()
  await h.send(VALID_STATUS_FRAME)
  const before = screen.getByRole('status').parentElement!.textContent
  expect(before).toContain('last change')
  expect(before).toContain('checked')
  fireEvent(window, new Event('pagehide'))
  await settle()
  expect(screen.getByRole('status').textContent).toBe('Reconnecting')
  expect(screen.getByTestId('status').className).toContain('dimmed')
  fireEvent(window, new Event('pageshow'))
  await settle()
  expect(h.requests).toHaveLength(2)
  expect(screen.getByRole('status').textContent).toBe('Reconnecting')
  await h.send(VALID_STATUS_FRAME)
  expect(screen.getByRole('status').textContent).toBe('Live')
  expect(screen.getByTestId('status').className).not.toContain('dimmed')
})
