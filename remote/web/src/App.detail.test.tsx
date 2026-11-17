import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { MessagesResponse, StatusFrame } from '../../../src/core/remote/protocol'
import {
  VALID_MESSAGES_RESPONSE,
  VALID_STATUS_FRAME
} from '../../../src/core/remote/protocol-vectors'
import { App } from './App'

// Recent messages in the page (TASK-033) with a scripted Mac. Synthetic text only.

const settle = () => act(() => new Promise((done) => setTimeout(done, 10)))
const SESSION = VALID_STATUS_FRAME.status.projects[0]!.sessions[0]!
const TEXT = 'Synthetic detail sentinel'

beforeEach(() => window.history.replaceState(null, '', '/'))
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const event = (value: object) =>
  `event: ${(value as { type: string }).type}\ndata: ${JSON.stringify(value)}\n\n`

function status(change: Partial<StatusFrame> = {}): StatusFrame {
  return { ...VALID_STATUS_FRAME, details: true, ...change }
}

function reply(text = TEXT): MessagesResponse {
  return {
    ...VALID_MESSAGES_RESPONSE,
    result: {
      state: 'messages',
      entries: [
        { kind: 'prompt', text: 'Synthetic prompt', at: 1, cut: false },
        { kind: 'tool-calls', count: 3, at: 2 },
        { kind: 'reply', text, at: 3, cut: true }
      ],
      older: true
    }
  }
}

/** The status stream the test writes to, and the recent-message answers it queues. */
function mac() {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const requests: string[] = []
  const answers: (() => Response)[] = []
  const fetch = ((input: string, init?: RequestInit) => {
    requests.push(`${init?.method ?? 'GET'} ${input}`)
    if (input.endsWith('/messages')) {
      const answer = answers.shift()
      return answer ? Promise.resolve(answer()) : new Promise(() => undefined)
    }
    const body = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) })
    return Promise.resolve(
      new Response(body, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } })
    )
  }) as typeof globalThis.fetch
  return {
    fetch,
    requests,
    answer: (body: object, code = 200) =>
      answers.push(
        () =>
          new Response(JSON.stringify(body), {
            status: code,
            headers: { 'Content-Type': 'application/json' }
          })
      ),
    send: async (value: object) => {
      controller.enqueue(new TextEncoder().encode(event(value)))
      await settle()
    },
    end: async (value: object) => {
      controller.enqueue(new TextEncoder().encode(event(value)))
      controller.close()
      await settle()
    }
  }
}

const rowButton = () => screen.getByRole('button', { name: /Session 1/ })

it('keeps rows as text while the Mac does not share recent messages', async () => {
  const m = mac()
  render(<App fetch={m.fetch} />)
  await settle()
  await m.send(VALID_STATUS_FRAME)
  expect(screen.queryByRole('button', { name: /Session 1/ })).toBeNull()
  expect(m.requests).toEqual(['GET /v2/status'])
})

it('opens recent messages inertly, with older/cut notices and no read acknowledgement', async () => {
  const m = mac()
  render(<App fetch={m.fetch} />)
  await settle()
  await m.send(status())
  m.answer(reply(`${TEXT} <img src=x onerror="window.pwned=1"> [link](https://example.invalid)`))
  fireEvent.click(rowButton())
  await settle()
  const detail = screen.getByTestId('detail')
  expect(detail.textContent).toContain(TEXT)
  expect(detail.textContent).toContain('<img src=x onerror="window.pwned=1">')
  expect(detail.textContent).toContain('3 tool calls')
  expect(detail.textContent).toContain('Only the latest messages are shown.')
  expect(detail.textContent).toContain('Shortened to fit.')
  expect(detail.querySelectorAll('a, img')).toHaveLength(0)
  expect(document.activeElement?.tagName).toBe('H2')
  expect(rowButton().getAttribute('aria-current')).toBe('true')
  // One GET for the messages; nothing that could mark a reply read on the Mac.
  expect(m.requests).toEqual(['GET /v2/status', `GET /v2/sessions/${SESSION.id}/messages`])
})

it('Back returns to the list, and the history entry holds only a fixed marker', async () => {
  const m = mac()
  render(<App fetch={m.fetch} />)
  await settle()
  await m.send(status())
  m.answer(reply())
  const length = window.history.length
  fireEvent.click(rowButton())
  await settle()
  expect(window.history.length).toBe(length + 1)
  expect(window.history.state).toEqual({ agentpeek: 'detail' })
  expect(JSON.stringify(window.history.state)).not.toContain(SESSION.id)
  expect(window.location.href).not.toContain(SESSION.id)

  fireEvent.click(screen.getByRole('button', { name: 'Back to sessions' }))
  await act(() => new Promise((done) => window.addEventListener('popstate', done, { once: true })))
  await settle()
  expect(screen.queryByTestId('detail')).toBeNull()
  expect(document.body.textContent).not.toContain(TEXT)
  expect(document.activeElement).toBe(rowButton())
})

it('the Back gesture (popstate) closes the detail and drops the text', async () => {
  const m = mac()
  render(<App fetch={m.fetch} />)
  await settle()
  await m.send(status())
  m.answer(reply())
  fireEvent.click(rowButton())
  await settle()
  act(() => {
    window.history.replaceState(null, '')
    window.dispatchEvent(new PopStateEvent('popstate', { state: null }))
  })
  await settle()
  expect(screen.queryByTestId('detail')).toBeNull()
  expect(document.body.textContent).not.toContain(TEXT)
})

it('clears the text when sharing stops, the session leaves, or access ends', async () => {
  const m = mac()
  render(<App fetch={m.fetch} />)
  await settle()
  await m.send(status())
  m.answer(reply())
  fireEvent.click(rowButton())
  await settle()
  expect(document.body.textContent).toContain(TEXT)

  await m.send(status({ details: false, snapshotId: 's2' }))
  expect(document.body.textContent).not.toContain(TEXT)
  expect(screen.getByText('Recent messages are not shared.')).toBeTruthy()

  m.answer(reply())
  await m.send(status({ generation: 4, snapshotId: 's3' }))
  expect(document.body.textContent).not.toContain(TEXT)
  m.answer({ ...reply(), generation: 4 })
  fireEvent.click(screen.getByRole('button', { name: 'Back to sessions' }))
  await act(() => new Promise((done) => window.addEventListener('popstate', done, { once: true })))
  fireEvent.click(rowButton())
  await settle()
  expect(document.body.textContent).toContain(TEXT)

  await m.end({ v: 2, type: 'end', reason: 'remote-off' })
  expect(document.body.textContent).not.toContain(TEXT)
  expect(screen.queryByTestId('detail')).toBeNull()
})

it('never writes the text to storage, the URL, history or the console', async () => {
  const m = mac()
  const writes = vi.spyOn(Storage.prototype, 'setItem')
  const logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map((name) =>
    vi.spyOn(console, name)
  )
  render(<App fetch={m.fetch} />)
  await settle()
  await m.send(status())
  m.answer(reply())
  fireEvent.click(rowButton())
  await settle()
  expect(document.body.textContent).toContain(TEXT)
  expect(writes).not.toHaveBeenCalled()
  for (const log of logs) {
    expect(JSON.stringify(log.mock.calls)).not.toContain(TEXT)
  }
  expect(JSON.stringify(window.history.state)).not.toContain(TEXT)
  expect(window.location.href).not.toContain('Synthetic')
})
