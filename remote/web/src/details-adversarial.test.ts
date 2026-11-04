import { afterEach, expect, it, vi } from 'vitest'
import type { MessagesResponse, StatusFrame } from '../../../src/core/remote/protocol'
import {
  VALID_MESSAGES_RESPONSE,
  VALID_STATUS_FRAME
} from '../../../src/core/remote/protocol-vectors'
import { createDetails, type DetailState } from './details'

// TASK-034: adversarial viewer cases, apart from the TASK-033 suite. A scripted Mac answers in any
// order, ignores aborts when told to, and replays old answers. Synthetic text only; each text
// names who it belongs to, so a wrong one on screen is found by one search.

const A = VALID_STATUS_FRAME.status.projects[0]!.sessions[0]!.id
const B = 'BBBBBBBBBBBBBBBBBBBBBB'
const SENTINEL = 'SENTINEL-M2-VIEWER'

function status(
  generation: number,
  change: Partial<StatusFrame> = {},
  sessions = [A, B]
): StatusFrame {
  const base = VALID_STATUS_FRAME.status.projects[0]!.sessions[0]!
  return {
    ...VALID_STATUS_FRAME,
    details: true,
    generation,
    ...change,
    status: {
      ...VALID_STATUS_FRAME.status,
      projects: [
        {
          label: 'synthetic-project',
          sessions: sessions.map((id) => ({ ...base, id, lastActivityAt: 1 }))
        }
      ]
    }
  }
}

const textFor = (session: string, tag: string) => `${SENTINEL} ${session.slice(0, 2)} ${tag}`

function messages(session: string, generation: number, tag: string): MessagesResponse {
  return {
    ...VALID_MESSAGES_RESPONSE,
    session,
    generation,
    result: {
      state: 'messages',
      entries: [{ kind: 'reply', text: textFor(session, tag), at: 1, cut: false }],
      older: false
    }
  }
}

const json = (body: unknown, code = 200) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: code,
    headers: { 'Content-Type': 'application/json' }
  })

const flush = () => new Promise((done) => setTimeout(done, 0))

/** `ignoreAbort`: the fetch resolves even after abort, like a response already in the buffer. */
function harness(ignoreAbort = false) {
  const calls: { url: string; init: RequestInit; answer: (r: Response) => void }[] = []
  const states: (DetailState | null)[] = []
  const timers: { run: () => void; ms: number }[] = []
  const fetch = ((url: string, init: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      calls.push({ url, init, answer: resolve })
      if (!ignoreAbort) {
        init.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError'))
        )
      }
    })) as typeof globalThis.fetch
  const details = createDetails({
    fetch,
    onChange: (state) => states.push(structuredClone(state)),
    now: () => 0,
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
    states,
    last: () => states.at(-1),
    shown: () => JSON.stringify(states.at(-1) ?? null),
    answer: async (index: number, response: Response) => {
      calls[index]!.answer(response)
      await flush()
    }
  }
}

const console_: string[] = []
for (const method of ['log', 'info', 'debug', 'warn', 'error'] as const) {
  vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
    console_.push(args.map(String).join(' '))
  })
}
afterEach(() => {
  // No viewer path writes detail text, or anything else, to the console.
  expect(console_).toEqual([])
})

it('A, B, A in quick succession with answers in reverse order shows only the last A', async () => {
  for (const ignoreAbort of [false, true]) {
    const mac = harness(ignoreAbort)
    mac.details.status(status(3))
    mac.details.open(A)
    mac.details.open(B)
    mac.details.open(A)
    expect(mac.calls).toHaveLength(3)
    await mac.answer(2, json(messages(A, 3, 'third')))
    await mac.answer(1, json(messages(B, 3, 'second')))
    await mac.answer(0, json(messages(A, 3, 'first')))
    expect(mac.shown()).toContain(textFor(A, 'third'))
    // No intermediate state ever showed the stale answers.
    const all = JSON.stringify(mac.states)
    expect(all).not.toContain(textFor(B, 'second'))
    expect(all).not.toContain(textFor(A, 'first'))
  }
})

it('a late answer after close, pause, details off or removal never comes back on screen', async () => {
  const leave: [string, (mac: ReturnType<typeof harness>) => void][] = [
    ['close', (mac) => mac.details.close()],
    ['pause', (mac) => mac.details.pause()],
    ['details off', (mac) => mac.details.status(status(4, { details: false }))],
    ['removed', (mac) => mac.details.status(status(3, {}, [B]))]
  ]
  for (const [name, action] of leave) {
    const mac = harness(true)
    mac.details.status(status(3))
    mac.details.open(A)
    action(mac)
    await mac.answer(0, json(messages(A, 4, name)))
    expect(JSON.stringify(mac.states), name).not.toContain(SENTINEL)
  }
})

it('a replayed older answer after a newer status is discarded, and the newer one is asked for', async () => {
  const mac = harness(true)
  mac.details.status(status(3))
  mac.details.open(A)
  await mac.answer(0, json(messages(A, 3, 'g3')))
  expect(mac.shown()).toContain(textFor(A, 'g3'))
  mac.details.status(status(5))
  // The text from generation 3 was dropped at once.
  expect(mac.shown()).not.toContain(SENTINEL)
  expect(mac.calls).toHaveLength(2)
  // The Mac (or anything on the path) replays the old answer for the new request.
  await mac.answer(1, json(messages(A, 3, 'replayed')))
  expect(JSON.stringify(mac.states.slice(-2))).not.toContain('replayed')
})

it('an answer naming another session, even the one shown before, is discarded', async () => {
  const mac = harness()
  mac.details.status(status(3))
  mac.details.open(B)
  await mac.answer(0, json(messages(A, 3, 'swapped')))
  expect(JSON.stringify(mac.states)).not.toContain('swapped')
})

it('forged answers with extra keys, other shapes or a text-bearing error show nothing', async () => {
  const forged: Response[] = [
    json({ ...messages(A, 3, 'extra'), details: true }),
    json({ ...messages(A, 3, 'v3'), v: 3 }),
    json({ ...messages(A, 3, 'type'), type: 'status' }),
    json({ v: 2, error: 'not-found', message: `${SENTINEL} error text` }, 404),
    json({ v: 2, error: `${SENTINEL} code` }, 409),
    json(`${SENTINEL} not json`),
    json({
      ...messages(A, 3, 'tool'),
      result: {
        state: 'messages',
        older: false,
        entries: [{ kind: 'tool-calls', count: 1, at: 1, names: [SENTINEL] }]
      }
    }),
    // Over 72 KiB announced: the body is not even read.
    new Response(JSON.stringify(messages(A, 3, 'big')), {
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(80 * 1024) }
    })
  ]
  for (const [index, response] of forged.entries()) {
    const mac = harness()
    mac.details.status(status(3))
    mac.details.open(A)
    await mac.answer(0, response)
    expect(JSON.stringify(mac.states), `forged ${index}`).not.toContain(SENTINEL)
    expect(mac.last()?.view.kind, `forged ${index}`).not.toBe('messages')
  }
})

it('a queued busy retry is dropped when sharing is revoked before it fires', async () => {
  for (const revoke of [
    (mac: ReturnType<typeof harness>) => mac.details.status(status(4, { details: false })),
    (mac: ReturnType<typeof harness>) => mac.details.pause(),
    (mac: ReturnType<typeof harness>) => mac.details.close()
  ]) {
    const mac = harness()
    mac.details.status(status(3))
    mac.details.open(A)
    await mac.answer(0, json({ v: 2, error: 'busy' }, 503))
    expect(mac.timers).toHaveLength(1)
    revoke(mac)
    expect(mac.timers).toHaveLength(0)
    expect(mac.calls).toHaveLength(1)
  }
})

it('a queued policy-changed retry is dropped when the next status revokes sharing', async () => {
  const mac = harness()
  mac.details.status(status(3))
  mac.details.open(A)
  await mac.answer(0, json({ v: 2, error: 'policy-changed' }, 409))
  mac.details.status(status(4, { details: false }))
  expect(mac.calls).toHaveLength(1)
  expect(mac.last()).toMatchObject({ view: { kind: 'not-shared' } })
  // Sharing on again under a newer generation: one fresh request, never the old answer.
  mac.details.status(status(5))
  expect(mac.calls).toHaveLength(2)
  await mac.answer(1, json(messages(A, 5, 'fresh')))
  expect(mac.shown()).toContain(textFor(A, 'fresh'))
})

it('off then on again with the same generation does not resurrect dropped text', async () => {
  const mac = harness(true)
  mac.details.status(status(3))
  mac.details.open(A)
  await mac.answer(0, json(messages(A, 3, 'before')))
  mac.details.status(status(3, { details: false }))
  expect(mac.shown()).not.toContain(SENTINEL)
  mac.details.status(status(3))
  // Asked again rather than showing the earlier text from memory.
  expect(mac.calls).toHaveLength(2)
  expect(mac.shown()).not.toContain('before')
})

it('a hundred random interleavings never show text for a session that is not open', async () => {
  let seed = 7
  const next = () => (seed = (seed * 1_103_515_245 + 12_345) >>> 0) / 2 ** 32
  for (let round = 0; round < 100; round += 1) {
    const mac = harness(next() < 0.5)
    let generation = 3
    let open: string | null = null
    let live = true
    let shared = true
    mac.details.status(status(generation))
    for (let step = 0; step < 12; step += 1) {
      const roll = next()
      if (roll < 0.25) {
        open = next() < 0.5 ? A : B
        mac.details.open(open)
      } else if (roll < 0.35) {
        open = null
        mac.details.close()
      } else if (roll < 0.45) {
        live = false
        mac.details.pause()
      } else if (roll < 0.6) {
        live = true
        shared = next() < 0.7
        if (next() < 0.5) generation += 1
        mac.details.status(status(generation, { details: shared }))
      } else if (mac.calls.length > 0) {
        const index = Math.floor(next() * mac.calls.length)
        const session = mac.calls[index]!.url.split('/')[3]!
        const answerGeneration = generation - (next() < 0.3 ? 1 : 0)
        await mac.answer(index, json(messages(session, answerGeneration, `r${round}s${step}`)))
      }
      const state = mac.last()
      if (state?.view.kind === 'messages') {
        expect(open, `round ${round} step ${step}`).toBe(state.session)
        expect(live && shared, `round ${round} step ${step}`).toBe(true)
        const text = state.view.entries[0]
        expect(text && 'text' in text ? text.text : '').toContain(textFor(state.session, ''))
      }
    }
  }
})
