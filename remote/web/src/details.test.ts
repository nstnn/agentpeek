import { expect, it } from 'vitest'
import type { MessagesResponse, StatusFrame } from '../../../src/core/remote/protocol'
import {
  VALID_MESSAGES_RESPONSE,
  VALID_STATUS_FRAME
} from '../../../src/core/remote/protocol-vectors'
import { createDetails, type DetailState } from './details'

// The viewer binding of protocol v2 with a scripted Mac and manual timers. Synthetic text only.

const A = VALID_STATUS_FRAME.status.projects[0]!.sessions[0]!.id
const B = 'BBBBBBBBBBBBBBBBBBBBBB'

function status(change: Partial<StatusFrame> = {}, sessions = [A, B], activity = 1): StatusFrame {
  const base = VALID_STATUS_FRAME.status.projects[0]!.sessions[0]!
  return {
    ...VALID_STATUS_FRAME,
    details: true,
    ...change,
    status: {
      ...VALID_STATUS_FRAME.status,
      projects: [
        {
          label: 'synthetic-project',
          sessions: sessions.map((id) => ({ ...base, id, lastActivityAt: activity }))
        }
      ]
    }
  }
}

function messages(session: string, text: string, generation = 3): MessagesResponse {
  return {
    ...VALID_MESSAGES_RESPONSE,
    session,
    generation,
    result: {
      state: 'messages',
      entries: [{ kind: 'reply', text, at: 1, cut: false }],
      older: false
    }
  }
}

const json = (body: object, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
const error = (code: string, status: number) => json({ v: 2, error: code }, status)

const flush = () => new Promise((done) => setTimeout(done, 0))

/** A Mac whose answers the test releases one by one, in any order. */
function harness() {
  const calls: { url: string; init: RequestInit; answer: (r: Response) => void }[] = []
  const states: (DetailState | null)[] = []
  const timers: { run: () => void; ms: number }[] = []
  let clock = 0
  const fetch = ((url: string, init: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      calls.push({ url, init, answer: resolve })
      init.signal?.addEventListener('abort', () =>
        reject(new DOMException('aborted', 'AbortError'))
      )
    })) as typeof globalThis.fetch
  const details = createDetails({
    fetch,
    onChange: (state) => states.push(state),
    now: () => clock,
    setTimer: (run, ms) => {
      const timer = { run, ms }
      timers.push(timer)
      return timer
    },
    clearTimer: (timer) => {
      const index = timers.indexOf(timer as (typeof timers)[number])
      if (index !== -1) timers.splice(index, 1)
    }
  })
  return {
    details,
    calls,
    timers,
    last: () => states.at(-1),
    texts: () => JSON.stringify(states),
    advance: (ms: number) => (clock += ms),
    answer: async (index: number, response: Response) => {
      calls[index]!.answer(response)
      await flush()
    }
  }
}

it('asks once with a credential-free, uncached GET and shows the bound answer', async () => {
  const mac = harness()
  mac.details.status(status())
  mac.details.open(A)
  expect(mac.last()).toEqual({ session: A, view: { kind: 'loading' } })
  expect(mac.calls).toHaveLength(1)
  expect(mac.calls[0]!.url).toBe(`/v2/sessions/${A}/messages`)
  expect(mac.calls[0]!.init).toMatchObject({
    method: 'GET',
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'error',
    referrerPolicy: 'no-referrer'
  })
  expect(mac.calls[0]!.init.body).toBeUndefined()
  await mac.answer(0, json(messages(A, 'Synthetic reply A')))
  expect(mac.last()).toMatchObject({ session: A, view: { kind: 'messages', older: false } })
})

it('never lets a late answer replace another session or restore a closed detail', async () => {
  const mac = harness()
  mac.details.status(status())
  mac.details.open(A)
  mac.details.open(B)
  expect(mac.calls[0]!.init.signal?.aborted).toBe(true)
  await mac.answer(1, json(messages(B, 'Synthetic reply B')))
  // A's answer after the switch, even with a matching body, is not shown.
  await mac.answer(0, json(messages(A, 'Synthetic reply A')))
  expect(mac.last()).toMatchObject({ session: B, view: { kind: 'messages' } })
  expect(JSON.stringify(mac.last())).not.toContain('Synthetic reply A')

  mac.details.open(A)
  mac.details.close()
  await mac.answer(2, json(messages(A, 'Synthetic late A')))
  expect(mac.last()).toBeNull()
  expect(mac.texts()).not.toContain('Synthetic late A')
})

it('discards an answer for another session or an older generation unread', async () => {
  const mac = harness()
  mac.details.status(status())
  mac.details.open(A)
  await mac.answer(0, json(messages(B, 'Synthetic wrong session')))
  expect(mac.last()?.view.kind).toBe('loading')
  mac.details.close()
  mac.details.open(A)
  await mac.answer(1, json(messages(A, 'Synthetic old generation', 2)))
  expect(mac.last()?.view.kind).toBe('loading')
  expect(mac.texts()).not.toContain('Synthetic wrong session')
  expect(mac.texts()).not.toContain('Synthetic old generation')
})

it('drops the text when the Mac stops sharing details or the session', async () => {
  const mac = harness()
  mac.details.status(status())
  mac.details.open(A)
  await mac.answer(0, json(messages(A, 'Synthetic shown')))
  mac.details.status(status({ details: false, snapshotId: 's2' }))
  expect(mac.last()).toEqual({ session: A, view: { kind: 'not-shared' } })

  // Shared again under a new generation: asked again, nothing old comes back.
  mac.details.status(status({ generation: 4, snapshotId: 's3' }))
  expect(mac.last()?.view.kind).toBe('loading')
  expect(mac.calls).toHaveLength(2)
  mac.details.status(status({ generation: 4, snapshotId: 's4' }, [B]))
  expect(mac.last()).toEqual({ session: A, view: { kind: 'unavailable', reason: 'gone' } })
  expect(mac.calls[1]!.init.signal?.aborted).toBe(true)
  await mac.answer(1, json(messages(A, 'Synthetic after removal', 4)))
  expect(mac.last()?.view).toEqual({ kind: 'unavailable', reason: 'gone' })
})

it('drops the text and asks again on a higher generation', async () => {
  const mac = harness()
  mac.details.status(status())
  mac.details.open(A)
  await mac.answer(0, json(messages(A, 'Synthetic gen 3')))
  mac.details.status(status({ generation: 4, snapshotId: 's2' }))
  expect(mac.last()?.view.kind).toBe('loading')
  expect(mac.calls).toHaveLength(2)
  await mac.answer(1, json(messages(A, 'Synthetic gen 4', 4)))
  expect(JSON.stringify(mac.last())).toContain('Synthetic gen 4')
})

it('pauses on a drop: text gone, late answers ignored, asked again when live', async () => {
  const mac = harness()
  mac.details.status(status())
  mac.details.open(A)
  mac.details.pause()
  expect(mac.last()).toEqual({ session: A, view: { kind: 'paused' } })
  await mac.answer(0, json(messages(A, 'Synthetic during drop')))
  expect(mac.last()?.view.kind).toBe('paused')
  mac.details.status(status({ snapshotId: 's2' }))
  expect(mac.calls).toHaveLength(2)
  await mac.answer(1, json(messages(A, 'Synthetic after drop')))
  expect(mac.last()?.view.kind).toBe('messages')
  expect(mac.texts()).not.toContain('Synthetic during drop')
})

it('maps the typed errors: details-off, not-found, not-allowed', async () => {
  const mac = harness()
  mac.details.status(status())
  mac.details.open(A)
  await mac.answer(0, error('details-off', 403))
  expect(mac.last()?.view).toEqual({ kind: 'not-shared' })
  mac.details.open(B)
  await mac.answer(1, error('not-found', 404))
  expect(mac.last()?.view).toEqual({ kind: 'unavailable', reason: 'gone' })
  mac.details.open(A)
  await mac.answer(2, error('not-allowed', 403))
  expect(mac.last()).toBeNull()
})

it('retries policy-changed once after the next status, then gives up', async () => {
  const mac = harness()
  mac.details.status(status())
  mac.details.open(A)
  await mac.answer(0, error('policy-changed', 409))
  expect(mac.calls).toHaveLength(1)
  mac.details.status(status({ snapshotId: 's2' }))
  expect(mac.calls).toHaveLength(2)
  await mac.answer(1, error('policy-changed', 409))
  mac.details.status(status({ snapshotId: 's3' }))
  expect(mac.calls).toHaveLength(2)
  expect(mac.last()?.view).toEqual({ kind: 'failed' })
  mac.details.retry()
  expect(mac.calls).toHaveLength(3)
})

it('retries busy once after 5 s', async () => {
  const mac = harness()
  mac.details.status(status())
  mac.details.open(A)
  await mac.answer(0, error('busy', 503))
  expect(mac.timers.map((timer) => timer.ms)).toEqual([5000])
  mac.timers.shift()!.run()
  expect(mac.calls).toHaveLength(2)
  await mac.answer(1, error('busy', 503))
  expect(mac.timers).toHaveLength(0)
  expect(mac.last()?.view).toEqual({ kind: 'failed' })
})

it('shows failed for a malformed or oversized answer', async () => {
  const mac = harness()
  mac.details.status(status())
  mac.details.open(A)
  await mac.answer(0, json({ ...messages(A, 'Synthetic'), extra: 1 }))
  expect(mac.last()?.view).toEqual({ kind: 'failed' })
  mac.details.retry()
  await mac.answer(
    1,
    new Response('x'.repeat(80 * 1024), { headers: { 'Content-Type': 'application/json' } })
  )
  expect(mac.last()?.view).toEqual({ kind: 'failed' })
})

it('refreshes on new activity at most once every 2 s, keeping the text meanwhile', async () => {
  const mac = harness()
  mac.details.status(status())
  mac.details.open(A)
  await mac.answer(0, json(messages(A, 'Synthetic first')))
  mac.advance(500)
  mac.details.status(status({ snapshotId: 's2' }, [A, B], 2))
  mac.details.status(status({ snapshotId: 's3' }, [A, B], 3))
  expect(mac.calls).toHaveLength(1)
  expect(mac.timers.map((timer) => timer.ms)).toEqual([1500])
  expect(mac.last()?.view.kind).toBe('messages')
  mac.advance(1500)
  mac.timers.shift()!.run()
  expect(mac.calls).toHaveLength(2)
  expect(mac.last()?.view.kind).toBe('messages')
  // The same activity again asks nothing.
  await mac.answer(1, json(messages(A, 'Synthetic second')))
  mac.advance(5000)
  mac.details.status(status({ snapshotId: 's4' }, [A, B], 3))
  expect(mac.calls).toHaveLength(2)
})

it('opens without asking when details are off, the session is gone or the stream is down', () => {
  const mac = harness()
  mac.details.open(A)
  expect(mac.last()?.view).toEqual({ kind: 'paused' })
  mac.details.close()
  mac.details.status(status({ details: false }))
  mac.details.open(A)
  expect(mac.last()?.view).toEqual({ kind: 'not-shared' })
  mac.details.close()
  mac.details.status(status({ snapshotId: 's2' }, [B]))
  mac.details.open(A)
  expect(mac.last()?.view).toEqual({ kind: 'unavailable', reason: 'gone' })
  expect(mac.calls).toHaveLength(0)
})
