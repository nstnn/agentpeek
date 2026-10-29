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
      new Response(JSON.stringify({ v: 1, error }), {
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
  const label = VALID_STATUS_FRAME.status.projects[0]!.label
  expect(screen.getByRole('heading', { level: 2, name: label })).toBeTruthy()
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
  expect(screen.queryByRole('button')).toBeNull()
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

it('shows the waiting session under Needs attention with the header summary', async () => {
  render(<App fetch={stream(`event: status\ndata: ${JSON.stringify(VALID_STATUS_FRAME)}\n\n`)} />)
  await settle()
  const attention = screen.getByRole('region', { name: 'Needs attention' })
  expect(within(attention).getByRole('listitem').textContent).toBe(
    'Session 1, Claude Code · synthetic-project, Waiting for you · Permission'
  )
  expect(screen.getByText('1 needs you')).toBeTruthy()
  expect(screen.getByText('Claude Code: no access on the Mac.')).toBeTruthy()
  expect(screen.getByText('No other sessions.')).toBeTruthy()
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

const rowTexts = () => screen.queryAllByRole('listitem').map((item) => item.textContent)

it('replaces every row on each status, with no duplicate or stale rows', async () => {
  const mac = scripted()
  render(<App fetch={mac.fetch} />)
  await settle()
  await mac.send(
    frame('s1', [{ label: 'alpha', sessions: [row('a'), row('b', { tool: 'claude' })] }])
  )
  expect(rowTexts()).toEqual([
    'Session a, Codex, Running, 2 min ago',
    'Session b, Claude Code, Running, 2 min ago'
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
    'Session c, Codex, Idle, 2 min ago'
  ])
  expect(screen.getAllByText(/Session a/)).toHaveLength(1)
  expect(screen.queryByText(/Session b/)).toBeNull()
  expect(screen.getByText('1 new reply')).toBeTruthy()
})

it('filters by project and tool as page state only, sending nothing to the Mac', async () => {
  const mac = scripted()
  render(<App fetch={mac.fetch} />)
  await settle()
  await mac.send(
    frame('s1', [
      { label: 'alpha', sessions: [row('a'), row('b', { tool: 'claude' })] },
      { label: 'beta', sessions: [row('c')] }
    ])
  )
  const history = window.history.length
  const location = window.location.href

  fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'beta' } })
  expect(rowTexts()).toEqual(['Session c, Codex, Running, 2 min ago'])
  expect(screen.queryByRole('heading', { name: 'alpha' })).toBeNull()

  fireEvent.change(screen.getByLabelText('Project'), { target: { value: '' } })
  fireEvent.change(screen.getByLabelText('Tool'), { target: { value: 'claude' } })
  expect(rowTexts()).toEqual(['Session b, Claude Code, Running, 2 min ago'])

  fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'beta' } })
  expect(screen.getByText('No sessions match these filters.')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Show all' }))
  expect(rowTexts()).toHaveLength(3)

  // The filter survives a new status while its project is still shared.
  fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'beta' } })
  await mac.send(
    frame('s2', [
      { label: 'alpha', sessions: [row('a')] },
      { label: 'beta', sessions: [row('d')] }
    ])
  )
  expect(rowTexts()).toEqual(['Session d, Codex, Running, 2 min ago'])

  expect(mac.requests).toEqual(['GET /v1/status'])
  expect(window.history.length).toBe(history)
  expect(window.location.href).toBe(location)
})

it('drops a filter whose project the Mac stopped sharing', async () => {
  const mac = scripted()
  render(<App fetch={mac.fetch} />)
  await settle()
  await mac.send(
    frame('s1', [
      { label: 'alpha', sessions: [row('a')] },
      { label: 'beta', sessions: [row('c')] }
    ])
  )
  fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'beta' } })
  await mac.send({ ...frame('s2', [{ label: 'alpha', sessions: [row('a')] }]), generation: 4 })
  expect(rowTexts()).toEqual(['Session a, Codex, Running, 2 min ago'])
  expect(screen.queryByLabelText('Project')).toBeNull()

  // Shared again: the old filter does not come back on its own.
  await mac.send({
    ...frame('s3', [
      { label: 'alpha', sessions: [row('a')] },
      { label: 'beta', sessions: [row('c')] }
    ]),
    generation: 5
  })
  expect(rowTexts()).toHaveLength(2)
  expect(screen.getByLabelText<HTMLSelectElement>('Project').value).toBe('')
})

it('moves live ages on with the local clock between frames', async () => {
  let local = 1_000
  const mac = scripted()
  render(<App fetch={mac.fetch} now={() => local} tickMs={20} />)
  await settle()
  await mac.send(frame('s1', [{ label: 'alpha', sessions: [row('a')] }]))
  expect(rowTexts()).toEqual(['Session a, Codex, Running, 2 min ago'])
  local += 3 * 60_000
  await act(() => new Promise((done) => setTimeout(done, 50)))
  expect(rowTexts()).toEqual(['Session a, Codex, Running, 5 min ago'])
})

it('keeps the list on a heartbeat and moves only the checked time', async () => {
  const mac = scripted()
  render(<App fetch={mac.fetch} />)
  await settle()
  const first = frame('s1', [{ label: 'alpha', sessions: [row('a')] }])
  await mac.send(first)
  await mac.send({
    v: 1,
    type: 'heartbeat',
    snapshotId: 's1',
    generation: first.generation,
    sentAt: T + 3 * 60_000
  })
  expect(rowTexts()).toEqual(['Session a, Codex, Running, 5 min ago'])
})

it('clears the list and asks for a reload when a frame has another version', async () => {
  const mac = scripted()
  render(<App fetch={mac.fetch} />)
  await settle()
  await mac.send(frame('s1', [{ label: 'alpha', sessions: [row('a')] }]))
  await mac.send({ ...frame('s2', []), v: 2 })
  expect(screen.getByRole('status').textContent).toBe('Update needed')
  expect(screen.queryByTestId('status')).toBeNull()
  expect(screen.queryByText(/Session a/)).toBeNull()
  expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy()
})

it('says nothing needs you, and shows projects with no sessions', async () => {
  const mac = scripted()
  render(<App fetch={mac.fetch} />)
  await settle()
  await mac.send(
    frame('s1', [
      { label: 'alpha', sessions: [row('a')] },
      { label: 'beta', sessions: [] }
    ])
  )
  expect(screen.getByText('Nothing needs you right now.')).toBeTruthy()
  const beta = screen.getByRole('region', { name: 'beta' })
  expect(within(beta).getByText('No sessions.')).toBeTruthy()
})

it('clears the list when access changes and the next request is not allowed', async () => {
  const replies = [
    () =>
      openStream(
        event(frame('s1', [{ label: 'alpha', sessions: [row('a')] }])) +
          event({ v: 1, type: 'end', reason: 'access-changed' })
      ),
    () =>
      new Response(JSON.stringify({ v: 1, error: 'not-allowed' }), {
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
