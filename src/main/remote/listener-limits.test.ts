import { connect, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { REMOTE_LIMITS, type RemoteFrame, type StatusFrame } from '../../core/remote/protocol'
import { REMOTE_STATUS_LIMITS } from '../../core/remote/status-projection'
import { createSnapshot, type SessionsSnapshot } from '../../core/snapshot'
import { testSession } from '../test-support'
import {
  exchange,
  freePort,
  HOST,
  OWNER,
  OWNER_HEADERS,
  rawHead,
  send,
  subscribe
} from './http-test-support'
import {
  REMOTE_MAX_CONNECTIONS,
  startRemoteListener,
  type RemoteListener,
  type RemoteListenerOptions
} from './listener'
import type { ViewerFiles } from './viewer-files'

// TASK-022: resource limits, tested only against in-process listeners with synthetic data, fixed or
// stepped clocks and bounded counts. A refused request must do no work for the status: the
// listener reads `generation` once per status it builds, so its call count shows any work.

const SHARED = '/Users/synthetic/projects/shared-demo'
const OWNER_LINES = [`Host: ${HOST}`, `Tailscale-User-Login: ${OWNER}`]

function snapshot(step = 0, count = 2, title = 'Synthetic session'): SessionsSnapshot {
  return createSnapshot({
    sessions: Array.from({ length: count }, (_, n) =>
      testSession({
        key: { tool: 'codex', id: `synthetic-${n}` },
        summary: {
          title,
          workspacePath: SHARED,
          lastActivityAt: 1_000 + step * 1_000 + n,
          toolVersion: '0.162'
        }
      })
    ),
    health: { codex: { state: 'connected', lastReadAt: 1 }, claude: { state: 'not-installed' } },
    localState: { kind: 'available' },
    firstLaunch: false,
    fixture: true,
    takenAt: 1 + step
  })
}

/** The most rows the projection keeps, each with the longest title, in four-byte characters. */
const largest = (step: number) =>
  snapshot(step, REMOTE_STATUS_LIMITS.maxSessions, '😀'.repeat(REMOTE_STATUS_LIMITS.maxTextLength))

const VIEWER: ViewerFiles = {
  page: Buffer.from('<!doctype html><title>AgentPeek</title><div id="root"></div>'),
  assets: new Map([
    ['/assets/index-AbC123.js', { body: Buffer.from('void 0'), type: 'text/javascript' }],
    ['/assets/index-AbC123.css', { body: Buffer.from('body{}'), type: 'text/css' }]
  ])
}

const listeners: RemoteListener[] = []
async function start(change: Partial<RemoteListenerOptions> = {}) {
  let builds = 0
  const result = await startRemoteListener({
    port: await freePort(),
    access: { ownerLogin: OWNER, hostName: HOST },
    secret: new Uint8Array(32).fill(7),
    viewer: VIEWER,
    snapshot: () => snapshot(),
    sharing: () => ({ sharedWorkspaces: [SHARED], shareTitles: true }),
    generation: () => {
      builds += 1
      return 0
    },
    ...change
  })
  if (!result.ok) throw new Error(result.error)
  listeners.push(result.listener)
  return { listener: result.listener, port: result.listener.port, builds: () => builds }
}
afterEach(async () => {
  await Promise.all(listeners.splice(0).map((listener) => listener.close('shutdown')))
})

/** A clock that moves `step` ms each time it is read, so the rate limit never runs dry. */
const stepping = (step: number) => {
  let clock = 0
  return () => (clock += step)
}

const statuses = (frames: RemoteFrame[]) =>
  frames.filter((frame): frame is StatusFrame => frame.type === 'status')

const timers = () => process.getActiveResourcesInfo().filter((name) => name === 'Timeout')

/** A typed refusal written by the listener, never Node's own text or an exception. */
function expectTypedReply(reply: string, status: number, error: string) {
  expect(reply).toMatch(new RegExp(`^HTTP/1\\.1 ${status} `))
  expect(reply).toContain(`{"v":1,"error":"${error}"}`)
  expect(reply.toLowerCase()).toContain('cache-control: no-store')
  expect(reply.toLowerCase()).toContain('connection: close')
  expect(reply).not.toMatch(/HPE_|ERR_|Error|event:/)
}

describe('remote listener rate limit', () => {
  it('admits five page loads at once, then refuses before the identity check', async () => {
    let clock = 1_000
    const { listener, port, builds } = await start({ now: () => clock })
    const viewers = []
    for (let load = 0; load < 5; load += 1) {
      expect((await send(port)).status).toBe(200)
      expect((await send(port, { path: '/assets/index-AbC123.js' })).status).toBe(200)
      expect((await send(port, { path: '/assets/index-AbC123.css' })).status).toBe(200)
      const viewer = subscribe(port)
      await expect.poll(() => viewer.frames.length).toBe(1)
      viewers.push(viewer)
    }
    expect(listener.streamCount()).toBe(REMOTE_LIMITS.maxStreams)
    expect(builds()).toBe(5)

    // The burst is spent: the owner, a stranger and the page all get `rate-limited`, not `busy`
    // or `not-allowed`, and nothing is built for them.
    for (const headers of [{ ...OWNER_HEADERS }, { Host: HOST }]) {
      const reply = await send(port, { path: '/v1/status', headers })
      expect(reply.status).toBe(429)
      expect(reply.headers['retry-after']).toBe(String(REMOTE_LIMITS.retryAfterSeconds))
      expect(reply.headers['cache-control']).toBe('no-store')
      expect(JSON.parse(reply.body)).toEqual({ v: 1, error: 'rate-limited' })
    }
    const page = await send(port)
    expect(page.status).toBe(429)
    expect(page.body).toContain('Too many requests. Wait a few seconds, then reload this page.')
    expect(page.body).not.toMatch(/<script/)
    expect(builds()).toBe(5)

    // It refills at ten a second.
    clock += 1_000 / REMOTE_LIMITS.requestsPerSecond
    expect((await send(port)).status).toBe(200)
    expect((await send(port)).status).toBe(429)
    expect(viewers.every((viewer) => viewer.frames.length === 1)).toBe(true)
  })

  it('survives a reconnect storm without leaking streams or building more than it admits', async () => {
    let clock = 1_000
    const { listener, port, builds } = await start({ now: () => clock })
    const outcomes: number[] = []
    for (let attempt = 0; attempt < 2 * REMOTE_LIMITS.requestBurst; attempt += 1) {
      const viewer = subscribe(port)
      await expect.poll(() => viewer.response()).toBeDefined()
      outcomes.push(viewer.response()!.statusCode ?? 0)
      viewer.disconnect()
      await expect.poll(() => listener.streamCount()).toBe(0)
    }
    expect(outcomes.slice(0, REMOTE_LIMITS.requestBurst).every((code) => code === 200)).toBe(true)
    expect(outcomes.slice(REMOTE_LIMITS.requestBurst).every((code) => code === 429)).toBe(true)
    expect(builds()).toBe(REMOTE_LIMITS.requestBurst)
    clock += 1_000
    const next = subscribe(port)
    await expect.poll(() => next.frames.length).toBe(1)
  })
})

describe('remote listener checks under load', () => {
  it('still refuses a stranger, a foreign Host or Origin and non-GET with every stream taken', async () => {
    const { listener, port, builds } = await start({ now: stepping(100) })
    const open = Array.from({ length: REMOTE_LIMITS.maxStreams }, () => subscribe(port))
    await expect.poll(() => open.every((viewer) => viewer.frames.length === 1)).toBe(true)
    const built = builds()
    const refusals: [Record<string, string>, string, number, string?][] = [
      [{ Host: HOST }, 'not-allowed', 403],
      [{ ...OWNER_HEADERS, 'Tailscale-User-Login': 'someone@example.com' }, 'not-allowed', 403],
      [{ ...OWNER_HEADERS, Host: `127.0.0.1:${port}` }, 'bad-host', 421],
      [{ ...OWNER_HEADERS, Origin: 'https://evil.example' }, 'bad-origin', 403],
      [{ ...OWNER_HEADERS }, 'method-not-allowed', 405, 'POST'],
      // Only the owner reaches the stream cap.
      [{ ...OWNER_HEADERS }, 'busy', 503]
    ]
    for (const [headers, error, status, method] of refusals) {
      const reply = await send(port, { path: '/v1/status', headers, method })
      expect(reply.status, error).toBe(status)
      expect(JSON.parse(reply.body)).toEqual({ v: 1, error })
      expect(reply.body).not.toContain('event:')
    }
    expect(builds()).toBe(built)
    expect(listener.streamCount()).toBe(REMOTE_LIMITS.maxStreams)
  })

  it('drops connections over the socket bound and keeps serving 127.0.0.1 at its port', async () => {
    const { listener, port } = await start({ now: stepping(100) })
    const idle = await Promise.all(
      Array.from(
        { length: REMOTE_MAX_CONNECTIONS },
        () =>
          new Promise<Socket>((done) => {
            const socket = connect({ host: '127.0.0.1', port }, () => done(socket))
            socket.on('error', () => undefined)
          })
      )
    )
    const extra = await exchange(port, '')
    expect(extra.reply).toBe('')
    expect(extra.ms).toBeLessThan(1_000)
    for (const socket of idle) socket.destroy()
    await expect
      .poll(() =>
        send(port).then(
          (reply) => reply.status,
          () => 0
        )
      )
      .toBe(200)
    expect(listener.port).toBe(port)
  })
})

describe('remote listener request size and time', () => {
  it('answers oversize headers, a malformed request and a missing Host with typed errors', async () => {
    const { port, builds } = await start({ now: stepping(100) })
    const pad = (bytes: number) => `X-Pad: ${'a'.repeat(bytes)}`
    const oversize = await exchange(
      port,
      rawHead(['GET /v1/status HTTP/1.1', ...OWNER_LINES, pad(17 * 1024)])
    )
    expectTypedReply(oversize.reply, 400, 'bad-request')
    expect(oversize.reply).toContain("Content-Security-Policy: default-src 'none'")
    // Just under the bound is an ordinary request.
    const under = await exchange(
      port,
      rawHead(['GET / HTTP/1.1', ...OWNER_LINES, pad(15 * 1024), 'Connection: close'])
    )
    expect(under.reply).toMatch(/^HTTP\/1\.1 200 /)
    expectTypedReply((await exchange(port, 'BLAH /\r\n\r\n')).reply, 400, 'bad-request')
    expectTypedReply(
      (await exchange(port, 'GET / HTTP/1.1\r\nHost\r\n\r\n')).reply,
      400,
      'bad-request'
    )
    const noHost = await exchange(
      port,
      rawHead(['GET /v1/status HTTP/1.1', `Tailscale-User-Login: ${OWNER}`])
    )
    expectTypedReply(noHost.reply, 421, 'bad-host')
    expect(builds()).toBe(0)
  })

  it('closes an open stream without writing into it when a malformed request follows', async () => {
    const { listener, port } = await start({ now: stepping(100) })
    const socket = connect({ host: '127.0.0.1', port })
    let reply = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => (reply += chunk))
    socket.on('error', () => undefined)
    const closed = new Promise((done) => socket.on('close', done))
    socket.write(rawHead(['GET /v1/status HTTP/1.1', ...OWNER_LINES]))
    await expect.poll(() => reply).toContain('event: status')
    socket.write('BLAH /\r\n\r\n')
    await closed
    expect(reply).toMatch(/^HTTP\/1\.1 200 /)
    expect(reply.match(/HTTP\/1\.1/g)).toHaveLength(1)
    expect(reply).not.toContain('bad-request')
    await expect.poll(() => listener.streamCount()).toBe(0)
  })

  it('refuses non-GET and request bodies without inviting or waiting for the body', async () => {
    const { port, builds } = await start({ now: stepping(100) })
    const declared = `Content-Length: ${10 * 1024 * 1024}`
    // Most of the declared body never comes; the reply and the close do not wait for it.
    const post = await exchange(
      port,
      rawHead(['POST /v1/status HTTP/1.1', ...OWNER_LINES, declared]) + 'x'.repeat(1024)
    )
    expectTypedReply(post.reply, 405, 'method-not-allowed')
    expect(post.reply).toContain('Allow: GET')
    expect(post.ms).toBeLessThan(1_000)
    const expecting = await exchange(
      port,
      rawHead(['POST /v1/status HTTP/1.1', ...OWNER_LINES, declared, 'Expect: 100-continue'])
    )
    expect(expecting.reply).not.toContain('100 Continue')
    expectTypedReply(expecting.reply, 405, 'method-not-allowed')
    const body = await exchange(
      port,
      rawHead(['GET /v1/status HTTP/1.1', ...OWNER_LINES, 'Content-Length: 5']) + 'hello'
    )
    expectTypedReply(body.reply, 400, 'bad-request')
    expect(builds()).toBe(0)
  })

  it('puts a request with an unknown expectation through every check', async () => {
    const clock = 1_000
    const { port, builds } = await start({ now: () => clock })
    const unknown = 'Expect: synthetic-expectation'
    const stranger = rawHead([
      'GET /v1/status HTTP/1.1',
      `Host: ${HOST}`,
      unknown,
      'Connection: close'
    ])
    expectTypedReply((await exchange(port, stranger)).reply, 403, 'not-allowed')
    const post = rawHead(['POST /v1/status HTTP/1.1', ...OWNER_LINES, unknown, 'Connection: close'])
    expectTypedReply((await exchange(port, post)).reply, 405, 'method-not-allowed')
    // The owner's page is served as without the header, not refused with Node's bare 417.
    const page = rawHead(['GET / HTTP/1.1', ...OWNER_LINES, unknown, 'Connection: close'])
    expect((await exchange(port, page)).reply).toMatch(/^HTTP\/1\.1 200 /)
    // With the burst spent, the rate limit answers first.
    for (let request = 3; request < REMOTE_LIMITS.requestBurst; request += 1) {
      expect((await send(port)).status).toBe(200)
    }
    expectTypedReply((await exchange(port, stranger)).reply, 429, 'rate-limited')
    expect(builds()).toBe(0)
  })

  it('closes a connection that is too slow to send its request', async () => {
    const { port } = await start({ now: stepping(100), requestTimeoutMs: 300 })
    const [silent, partial] = await Promise.all([
      exchange(port, ''),
      exchange(port, `GET /v1/status HTTP/1.1\r\nHost: ${HOST}\r\n`)
    ])
    for (const { reply, ms } of [silent, partial]) {
      expectTypedReply(reply, 400, 'bad-request')
      // The timeout plus Node's one-second check interval, with room for a loaded machine.
      expect(ms).toBeLessThan(2_500)
    }
  })

  it('keeps an open status stream past the request time limit', async () => {
    const { listener, port } = await start({ now: stepping(100), requestTimeoutMs: 300 })
    const viewer = subscribe(port)
    await expect.poll(() => viewer.frames.length).toBe(1)
    await new Promise((done) => setTimeout(done, 1_500))
    expect(listener.streamCount()).toBe(1)
    expect(viewer.frames.map((frame) => frame.type)).toEqual(['status'])
  })

  it('never compresses a response', async () => {
    const { port } = await start({ now: stepping(100) })
    const headers = { ...OWNER_HEADERS, 'Accept-Encoding': 'gzip, deflate, br' }
    for (const path of ['/', '/assets/index-AbC123.js']) {
      const reply = await send(port, { path, headers })
      expect(reply.status).toBe(200)
      expect(reply.headers['content-encoding']).toBeUndefined()
    }
    const viewer = subscribe(port, headers)
    await expect.poll(() => viewer.frames.length).toBe(1)
    expect(viewer.response()!.headers['content-encoding']).toBeUndefined()
  })
})

describe('remote listener stream budget', () => {
  it('ends a stream that stops reading at its byte budget, without holding up the others', async () => {
    const before = timers().length
    let latest = largest(0)
    // Each read of the clock moves a second, so every publish is sent at once, unthrottled.
    const { listener, port } = await start({ snapshot: () => latest, now: stepping(1_000) })
    const viewer = subscribe(port)
    await expect.poll(() => viewer.frames.length).toBe(1)
    const stuck = connect({ host: '127.0.0.1', port })
    stuck.on('error', () => undefined)
    stuck.write(rawHead(['GET /v1/status HTTP/1.1', ...OWNER_LINES]))
    stuck.pause()
    await expect.poll(() => listener.streamCount()).toBe(2)

    // Statuses of about 192 KiB until the stuck stream is gone: first loopback's buffers fill (about
    // ten statuses on the Mac this was written on, more on others), then the 512 KiB budget. The
    // stream is ended and, unable to flush, dropped after the grace period. The reading viewer
    // takes each status before the next one, as it would at two a second.
    let step = 0
    while (listener.streamCount() === 2 && step < 40) {
      step += 1
      latest = largest(step)
      listener.publish(latest)
      await expect.poll(() => statuses(viewer.frames).length).toBe(1 + step)
    }
    expect(listener.streamCount()).toBe(1)
    expect(viewer.frames.some((frame) => frame.type === 'end')).toBe(false)
    // Every frame stayed within its payload budget and said how many rows it left out.
    for (const frame of statuses(viewer.frames)) {
      expect(frame.status.omitted.sessions).toBeGreaterThan(0)
      expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThanOrEqual(
        REMOTE_LIMITS.maxFrameBytes
      )
    }
    const gone = new Promise((done) => stuck.on('close', done))
    stuck.resume()
    await gone
    await listener.close('shutdown')
    // No timer of this listener is left; one from an earlier test may have finished meanwhile.
    expect(timers().length).toBeLessThanOrEqual(before)
  })
})
