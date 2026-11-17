import { describe, expect, it } from 'vitest'
import {
  NARROWED_STATUS_FRAME,
  VALID_STATUS_FRAME
} from '../../../src/core/remote/protocol-vectors'
import { REMOTE_LIMITS, type RemoteFrame } from '../../../src/core/remote/protocol'
import { createConnection, LOST_AFTER_FAILURES, type ViewerState } from './connection'

// Synthetic frames from the protocol vectors; the Mac is a scripted fetch.

const sse = (frame: RemoteFrame | Record<string, unknown>, type = String(frame.type)) =>
  `event: ${type}\ndata: ${JSON.stringify(frame)}\n\n`

interface OpenStream {
  push(text: string): void
  close(): void
}

type Reply =
  | { kind: 'stream'; ready: (stream: OpenStream) => void }
  | { kind: 'error'; status: number; body: string; type?: string }
  | { kind: 'network' }

function harness(replies: Reply[]) {
  let clock = 0
  let wallClock = 0
  const states: ViewerState[] = []
  const requests: { url: string; init: RequestInit | undefined }[] = []
  const timers: { run: () => void; ms: number }[] = []
  const scripted = (url: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve().then(() => reply(typeof url === 'string' ? url : 'not a string', init))
  const reply = (url: string, init: RequestInit | undefined): Response => {
    requests.push({ url, init })
    const next = replies.shift()
    if (!next || next.kind === 'network') throw new TypeError('Failed to fetch')
    if (next.kind === 'error') {
      return new Response(next.body, {
        status: next.status,
        headers: { 'Content-Type': next.type ?? 'application/json' }
      })
    }
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        next.ready({
          push: (text) => controller.enqueue(encoder.encode(text)),
          close: () => controller.close()
        })
      }
    })
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream; charset=utf-8' }
    })
  }
  const connection = createConnection({
    fetch: scripted,
    now: () => clock,
    wallNow: () => wallClock,
    random: () => 0.5,
    onChange: (state) => states.push(state),
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
    connection,
    states,
    requests,
    timers,
    advance(ms: number, wallMs = ms) {
      clock += ms
      wallClock += wallMs
    },
    last: () => states.at(-1),
    /** Runs the one pending reconnect timer and returns its delay. */
    async fire() {
      expect(timers).toHaveLength(1)
      const [timer] = timers.splice(0, 1)
      timer!.run()
      await settle()
      return timer!.ms
    }
  }
}

const settle = () => new Promise((done) => setTimeout(done, 5))

/** A stream that sends `frames` at once and stays open. */
const streamOf = (...texts: string[]): Reply => ({
  kind: 'stream',
  ready: (stream) => texts.forEach((text) => stream.push(text))
})

const errorReply = (error: string, status = 403): Reply => ({
  kind: 'error',
  status,
  body: JSON.stringify({ v: 2, error })
})

describe('Remote View connection', () => {
  it('asks for the stream without credentials, cache or referrer, and goes live on a status', async () => {
    const h = harness([streamOf(sse(VALID_STATUS_FRAME))])
    h.connection.start()
    expect(h.states[0]).toBeUndefined()
    await settle()
    expect(h.requests).toHaveLength(1)
    expect(h.requests[0]!.url).toBe('/v2/status')
    expect(h.requests[0]!.init).toMatchObject({
      method: 'GET',
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer'
    })
    expect(h.last()).toEqual({
      kind: 'live',
      data: {
        frame: VALID_STATUS_FRAME,
        lastSentAt: VALID_STATUS_FRAME.sentAt,
        receivedAt: expect.any(Number) as number
      }
    })
  })

  it('reads events split across chunks, and a heartbeat moves "checked" only', async () => {
    let open: OpenStream | undefined
    const h = harness([{ kind: 'stream', ready: (stream) => (open = stream) }])
    h.connection.start()
    await settle()
    const text = sse(VALID_STATUS_FRAME)
    open!.push(text.slice(0, 17))
    await settle()
    expect(h.states).toEqual([])
    open!.push(text.slice(17))
    await settle()
    expect(h.last()?.kind).toBe('live')
    const heartbeat = {
      v: 2,
      type: 'heartbeat',
      snapshotId: VALID_STATUS_FRAME.snapshotId,
      generation: VALID_STATUS_FRAME.generation,
      sentAt: VALID_STATUS_FRAME.sentAt + 15_000
    }
    open!.push(sse(heartbeat))
    await settle()
    expect(h.last()).toEqual({
      kind: 'live',
      data: {
        frame: VALID_STATUS_FRAME,
        lastSentAt: heartbeat.sentAt,
        receivedAt: expect.any(Number) as number
      }
    })
  })

  it('ignores a status with a lower generation within one stream', async () => {
    const newer = { ...NARROWED_STATUS_FRAME, generation: 5 }
    const older = { ...VALID_STATUS_FRAME, generation: 4 }
    const h = harness([streamOf(sse(newer), sse(older))])
    h.connection.start()
    await settle()
    expect(h.last()).toMatchObject({ kind: 'live', data: { frame: newer } })
  })

  it.each([
    ['not-allowed', 403, 'not-allowed'],
    ['bad-host', 421, 'bad-host'],
    ['bad-origin', 403, 'bad-host'],
    ['unsupported-version', 404, 'update-needed'],
    ['not-found', 404, 'failed'],
    ['bad-request', 400, 'failed'],
    ['method-not-allowed', 405, 'failed']
  ])('stops for good on %s, with no data and no retry', async (error, status, kind) => {
    const h = harness([errorReply(error, status)])
    h.connection.start()
    await settle()
    expect(h.last()).toEqual({ kind })
    expect(h.timers).toHaveLength(0)
    h.connection.retryNow()
    await settle()
    expect(h.requests).toHaveLength(1)
  })

  it('clears data and stops when a reconnect after a drop is refused', async () => {
    let open: OpenStream | undefined
    const h = harness([
      { kind: 'stream', ready: (stream) => (open = stream) },
      errorReply('not-allowed')
    ])
    h.connection.start()
    await settle()
    open!.push(sse(VALID_STATUS_FRAME))
    await settle()
    open!.close()
    await settle()
    expect(h.last()).toMatchObject({ kind: 'reconnecting', data: { frame: VALID_STATUS_FRAME } })
    await h.fire()
    expect(h.last()).toEqual({ kind: 'not-allowed' })
    expect(h.timers).toHaveLength(0)
  })

  it('reconnects with full jitter capped at 30 s and resets on a full status', async () => {
    const failures = 9
    const h = harness([
      streamOf(sse(VALID_STATUS_FRAME), sse({ v: 2, type: 'end', reason: 'shutdown' })),
      ...Array.from({ length: failures }, (): Reply => ({ kind: 'network' })),
      streamOf(sse(NARROWED_STATUS_FRAME))
    ])
    h.connection.start()
    await settle()
    const delays: number[] = []
    const kinds: string[] = []
    for (let i = 0; i <= failures; i += 1) {
      kinds.push(h.last()!.kind)
      delays.push(await h.fire())
    }
    // random() is 0.5: half of min(30 s, 1 s * 2^attempt).
    expect(delays).toEqual([500, 1000, 2000, 4000, 8000, 15_000, 15_000, 15_000, 15_000, 15_000])
    expect(Math.max(...delays)).toBeLessThan(REMOTE_LIMITS.reconnectMaxMs)
    // The old data stays, dimmed, until a full status replaces it.
    expect(kinds.slice(0, LOST_AFTER_FAILURES - 1)).toEqual(['reconnecting', 'reconnecting'])
    expect(kinds.slice(LOST_AFTER_FAILURES - 1).every((kind) => kind === 'lost')).toBe(true)
    expect(h.states.at(-2)).toMatchObject({ data: { frame: VALID_STATUS_FRAME } })
    expect(h.last()).toMatchObject({ kind: 'live', data: { frame: NARROWED_STATUS_FRAME } })
  })

  it("treats a reply that is not AgentPeek's, such as Serve's 502, as a drop", async () => {
    const h = harness([
      { kind: 'error', status: 502, body: 'Bad Gateway', type: 'text/plain' },
      streamOf(sse(VALID_STATUS_FRAME))
    ])
    h.connection.start()
    await settle()
    expect(h.last()).toEqual({ kind: 'reconnecting', data: null })
    await h.fire()
    expect(h.last()?.kind).toBe('live')
  })

  it('shows busy and retries, and Retry reconnects at once', async () => {
    const h = harness([errorReply('busy', 503), streamOf(sse(VALID_STATUS_FRAME))])
    h.connection.start()
    await settle()
    expect(h.last()).toEqual({ kind: 'busy', data: null })
    expect(h.timers).toHaveLength(1)
    h.connection.retryNow()
    await settle()
    expect(h.timers.map((timer) => timer.ms)).toEqual([REMOTE_LIMITS.silenceLimitMs])
    expect(h.last()?.kind).toBe('live')
  })

  it('clears the data on remote-off and keeps retrying slowly until it is on again', async () => {
    const h = harness([
      streamOf(sse(VALID_STATUS_FRAME), sse({ v: 2, type: 'end', reason: 'remote-off' })),
      { kind: 'error', status: 502, body: '', type: 'text/plain' },
      streamOf(sse(NARROWED_STATUS_FRAME))
    ])
    h.connection.start()
    await settle()
    expect(h.states.map((state) => state.kind)).toEqual(['live', 'off'])
    expect(h.last()).toEqual({ kind: 'off' })
    expect(await h.fire()).toBe(4000)
    expect(h.last()).toEqual({ kind: 'off' })
    expect(await h.fire()).toBe(8000)
    expect(h.last()).toMatchObject({ kind: 'live', data: { frame: NARROWED_STATUS_FRAME } })
  })

  it('clears the data on access-changed and asks once; a refusal then ends it', async () => {
    const h = harness([
      streamOf(sse(VALID_STATUS_FRAME), sse({ v: 2, type: 'end', reason: 'access-changed' })),
      errorReply('not-allowed')
    ])
    h.connection.start()
    await settle()
    expect(h.last()).toEqual({ kind: 'connecting' })
    await h.fire()
    expect(h.last()).toEqual({ kind: 'not-allowed' })
    expect(h.timers).toHaveLength(0)
  })

  it('stops on a frame of another protocol version and reconnects after a malformed one', async () => {
    const newer = harness([streamOf(sse({ ...VALID_STATUS_FRAME, v: 3 }))])
    newer.connection.start()
    await settle()
    expect(newer.last()).toEqual({ kind: 'update-needed' })
    expect(newer.timers).toHaveLength(0)

    const extra = harness([streamOf(sse({ ...VALID_STATUS_FRAME, path: '/Users/x' }))])
    extra.connection.start()
    await settle()
    expect(extra.last()).toEqual({ kind: 'reconnecting', data: null })
    expect(extra.timers).toHaveLength(1)
  })

  it('drops an event that grows past the frame budget', async () => {
    const h = harness([
      streamOf('event: status\ndata: ' + 'x'.repeat(REMOTE_LIMITS.maxFrameBytes + 100))
    ])
    h.connection.start()
    await settle()
    expect(h.last()).toEqual({ kind: 'reconnecting', data: null })
  })

  it('leaves no timer or stream after stop', async () => {
    const h = harness([{ kind: 'network' }])
    h.connection.start()
    await settle()
    expect(h.timers).toHaveLength(1)
    h.connection.stop()
    expect(h.timers).toHaveLength(0)
    h.connection.start()
    await settle()
    expect(h.requests).toHaveLength(1)
  })
})

describe('Remote View silence and resume', () => {
  it('leaves Live at 45 s of silence, aborts the old stream and starts with a full status', async () => {
    const h = harness([streamOf(sse(VALID_STATUS_FRAME)), streamOf(sse(NARROWED_STATUS_FRAME))])
    h.connection.start()
    await settle()
    h.advance(REMOTE_LIMITS.silenceLimitMs)
    expect(await h.fire()).toBe(45_000)
    expect(h.last()).toMatchObject({ kind: 'lost', data: { frame: VALID_STATUS_FRAME } })
    expect(h.requests[0]!.init!.signal!.aborted).toBe(true)
    await h.fire()
    expect(h.last()).toMatchObject({ kind: 'live', data: { frame: NARROWED_STATUS_FRAME } })
    h.connection.stop()
    expect(h.timers).toHaveLength(0)
  })

  it('keeps an unchanged old observation live while valid heartbeats arrive, preserving source health', async () => {
    let open!: OpenStream
    const h = harness([{ kind: 'stream', ready: (stream) => (open = stream) }])
    h.connection.start()
    await settle()
    open.push(sse(VALID_STATUS_FRAME))
    await settle()
    for (let beat = 1; beat <= 6; beat += 1) {
      h.advance(15_000)
      open.push(
        sse({
          v: 2,
          type: 'heartbeat',
          snapshotId: VALID_STATUS_FRAME.snapshotId,
          generation: VALID_STATUS_FRAME.generation,
          sentAt: VALID_STATUS_FRAME.sentAt + beat * 15_000
        })
      )
      await settle()
      expect(h.last()).toMatchObject({
        kind: 'live',
        data: { frame: VALID_STATUS_FRAME, lastSentAt: VALID_STATUS_FRAME.sentAt + beat * 15_000 }
      })
    }
    h.connection.stop()
  })

  it('does not count partial bytes as a valid frame', async () => {
    let open!: OpenStream
    const h = harness([{ kind: 'stream', ready: (stream) => (open = stream) }])
    h.connection.start()
    await settle()
    open.push(sse(VALID_STATUS_FRAME))
    await settle()
    h.advance(44_000)
    open.push('event: heartbeat\ndata: ')
    await settle()
    h.advance(1_000)
    await h.fire()
    expect(h.last()?.kind).toBe('lost')
    h.connection.stop()
  })

  it('detects OS sleep before accepting buffered frames, even if the monotonic clock paused', async () => {
    let open!: OpenStream
    const h = harness([{ kind: 'stream', ready: (stream) => (open = stream) }])
    h.connection.start()
    await settle()
    open.push(sse(VALID_STATUS_FRAME))
    await settle()
    h.advance(0, 60_000)
    open.push(sse(NARROWED_STATUS_FRAME))
    await settle()
    expect(h.last()).toMatchObject({ kind: 'lost', data: { frame: VALID_STATUS_FRAME } })
    expect(h.requests[0]!.init!.signal!.aborted).toBe(true)
    h.connection.stop()
  })

  it('suspends with no active timers and requires a new full status on resume', async () => {
    const h = harness([streamOf(sse(VALID_STATUS_FRAME)), streamOf(sse(NARROWED_STATUS_FRAME))])
    h.connection.start()
    await settle()
    h.connection.suspend()
    expect(h.last()).toMatchObject({ kind: 'reconnecting', data: { frame: VALID_STATUS_FRAME } })
    expect(h.timers).toHaveLength(0)
    h.advance(60_000)
    h.connection.resume()
    await settle()
    expect(h.requests).toHaveLength(2)
    expect(h.last()).toMatchObject({ kind: 'live', data: { frame: NARROWED_STATUS_FRAME } })
    h.connection.stop()
  })

  it('does not retry a final refusal when the tab resumes', async () => {
    const h = harness([errorReply('not-allowed')])
    h.connection.start()
    await settle()
    h.connection.suspend()
    h.connection.resume()
    h.connection.start()
    await settle()
    expect(h.requests).toHaveLength(1)
    expect(h.last()).toEqual({ kind: 'not-allowed' })
    expect(h.timers).toHaveLength(0)
  })

  it('requires a status before any heartbeat and resyncs on a mismatched heartbeat', async () => {
    const heartbeat = {
      v: 2,
      type: 'heartbeat',
      snapshotId: 'unknown',
      generation: VALID_STATUS_FRAME.generation,
      sentAt: 1
    }
    for (const prefix of [[], [sse(VALID_STATUS_FRAME)]]) {
      const h = harness([streamOf(...prefix, sse(heartbeat))])
      h.connection.start()
      await settle()
      expect(h.last()?.kind).toBe('reconnecting')
      h.connection.stop()
    }
  })

  it('bounds a request that never returns headers, and ignores its late response after resync', async () => {
    let release!: (response: Response) => void
    let calls = 0
    const states: ViewerState[] = []
    const timers: { run: () => void; ms: number }[] = []
    let clock = 0
    const response = (frame: RemoteFrame) =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(sse(frame)))
          }
        }),
        { headers: { 'Content-Type': 'text/event-stream' } }
      )
    const connection = createConnection({
      fetch: () =>
        ++calls === 1
          ? new Promise((done) => (release = done))
          : Promise.resolve(response(NARROWED_STATUS_FRAME)),
      now: () => clock,
      wallNow: () => clock,
      onChange: (state) => states.push(state),
      setTimer: (run, ms) => {
        const timer = { run, ms }
        timers.push(timer)
        return timer
      },
      clearTimer: (timer) => {
        const index = timers.indexOf(timer as (typeof timers)[number])
        if (index >= 0) timers.splice(index, 1)
      }
    })
    connection.start()
    clock = 45_000
    timers.shift()!.run()
    expect(states.at(-1)?.kind).toBe('lost')
    connection.retryNow()
    await settle()
    expect(states.at(-1)).toMatchObject({ kind: 'live', data: { frame: NARROWED_STATUS_FRAME } })
    release(response(VALID_STATUS_FRAME))
    await settle()
    expect(states.at(-1)).toMatchObject({ kind: 'live', data: { frame: NARROWED_STATUS_FRAME } })
    connection.stop()
    expect(timers).toHaveLength(0)
  })
})
