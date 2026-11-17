import { ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { REMOTE_LIMITS, type StatusFrame } from '../../core/remote/protocol'
import { createSnapshot } from '../../core/snapshot'
import { testSession } from '../test-support'
import { freePort, HOST, OWNER, send, subscribe } from './http-test-support'
import { startRemoteListener, type RemoteListener } from './listener'

const SHARED = '/Users/synthetic/projects/load-demo'
const snapshot = (step: number, title = 'Synthetic session') =>
  createSnapshot({
    sessions: Array.from({ length: 250 }, (_, n) =>
      testSession({
        key: { tool: 'codex', id: `synthetic-${n}` },
        summary: {
          title,
          workspacePath: SHARED,
          lastActivityAt: 1_000 + step + n,
          toolVersion: '1'
        }
      })
    ),
    health: { codex: { state: 'connected', lastReadAt: 1 }, claude: { state: 'not-installed' } },
    localState: { kind: 'available' },
    firstLaunch: false,
    fixture: true,
    takenAt: 1 + step
  })

const listeners: RemoteListener[] = []
afterEach(async () => {
  await Promise.all(listeners.splice(0).map((listener) => listener.close('shutdown')))
  vi.restoreAllMocks()
})

async function start() {
  let latest = snapshot(0)
  let generation = 0
  const result = await startRemoteListener({
    port: await freePort(),
    access: { ownerLogin: OWNER, hostName: HOST },
    secret: new Uint8Array(32).fill(7),
    viewer: { page: null, assets: new Map() },
    snapshot: () => latest,
    sharing: () => ({ sharedWorkspaces: [SHARED], shareTitles: true }),
    generation: () => generation
  })
  if (!result.ok) throw new Error(result.error)
  const { listener } = result
  listeners.push(listener)
  return {
    listener,
    publish(step: number, title?: string) {
      latest = snapshot(step, title)
      listener.publish(latest)
    },
    narrow() {
      generation += 1
      listener.resync()
    }
  }
}

/** Inject a delayed writable into one real HTTP stream. Other streams use their real sockets. */
function delayOne() {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- applied with the original response below
  const original = ServerResponse.prototype.write
  let delayed: ServerResponse | undefined
  let writes = 0
  vi.spyOn(ServerResponse.prototype, 'write').mockImplementation(function (
    this: ServerResponse,
    ...args: Parameters<typeof original>
  ) {
    const sent = original.apply(this, args)
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- retain this test's delayed HTTP response
    if (String(args[0]).startsWith('event: status') && !delayed) delayed = this
    if (this === delayed) {
      writes += 1
      return false
    }
    return sent
  })
  return {
    response: () => delayed!,
    writes: () => writes,
    drain() {
      delayed!.emit('drain')
    }
  }
}

describe('Remote View stream resilience', () => {
  it('replaces a blocked stream pending status while four other 250-row streams keep moving', async () => {
    const delay = delayOne()
    const h = await start()
    const slow = subscribe(h.listener.port)
    await expect.poll(() => slow.frames.length).toBe(1)
    const fast = Array.from({ length: 4 }, () => subscribe(h.listener.port))
    await expect.poll(() => fast.every((viewer) => viewer.frames.length === 1)).toBe(true)
    for (let step = 1; step <= 20; step += 1) h.publish(step)
    await expect.poll(() => fast.every((viewer) => viewer.frames.length === 2)).toBe(true)
    expect(delay.writes()).toBe(1)
    expect(delay.response().writableLength).toBeLessThan(REMOTE_LIMITS.maxBufferedBytesPerStream)
    delay.drain()
    await expect.poll(() => slow.frames.length).toBe(2)
    expect((slow.frames[1] as StatusFrame).observedAt).toBe(21)
    expect(slow.frames).toHaveLength(2)
    for (const viewer of fast) {
      const status = viewer.frames[1] as StatusFrame
      expect(status.status.projects[0]!.sessions).toHaveLength(250)
      expect(status.observedAt).toBe(21)
    }
  })

  it('ends a still-blocked stream at 45 s without blocking the other streams', async () => {
    const timeout = vi.spyOn(globalThis, 'setTimeout')
    const delay = delayOne()
    const h = await start()
    const slow = subscribe(h.listener.port)
    await expect.poll(() => slow.frames.length).toBe(1)
    const fast = subscribe(h.listener.port)
    await expect.poll(() => fast.frames.length).toBe(1)
    const expire = timeout.mock.calls.find((call) => call[1] === REMOTE_LIMITS.silenceLimitMs)![0]
    expect(typeof expire).toBe('function')
    if (typeof expire === 'function') expire()
    await slow.ended
    expect(slow.frames.at(-1)).toEqual({ v: 2, type: 'end', reason: 'slow-consumer' })
    expect(delay.response().writableEnded).toBe(true)
    h.publish(30)
    await expect.poll(() => fast.frames.length).toBe(2)
    expect(h.listener.streamCount()).toBe(1)
  })

  it('ends a stream when queued bytes plus its replacement exceed 512 KiB', async () => {
    const delay = delayOne()
    const h = await start()
    const slow = subscribe(h.listener.port)
    await expect.poll(() => slow.frames.length).toBe(1)
    Object.defineProperty(delay.response(), 'writableLength', {
      configurable: true,
      get: () => 400 * 1024
    })
    h.publish(1, '😀'.repeat(160))
    await slow.ended
    expect(slow.frames.at(-1)).toEqual({ v: 2, type: 'end', reason: 'slow-consumer' })
    expect(delay.writes()).toBe(1)
  })

  it('clears a blocked old-policy stream instead of sending its pending status after narrowing', async () => {
    const delay = delayOne()
    const h = await start()
    const slow = subscribe(h.listener.port)
    await expect.poll(() => slow.frames.length).toBe(1)
    h.publish(1)
    h.narrow()
    await slow.ended
    delay.drain()
    expect(slow.frames.map((frame) => frame.type)).toEqual(['status', 'end'])
    expect(slow.frames.at(-1)).toEqual({ v: 2, type: 'end', reason: 'access-changed' })
  })

  it('ends streams for sleep, rejects streams until wake, then starts with an unchanged full snapshot', async () => {
    const h = await start()
    const old = subscribe(h.listener.port)
    await expect.poll(() => old.frames.length).toBe(1)
    h.listener.suspend()
    await old.ended
    expect(old.frames.at(-1)).toEqual({ v: 2, type: 'end', reason: 'shutdown' })
    expect((await send(h.listener.port, { path: '/v2/status' })).status).toBe(503)
    h.listener.resume()
    const fresh = subscribe(h.listener.port)
    await expect.poll(() => fresh.frames.length).toBe(1)
    expect(fresh.frames[0]).toMatchObject({
      type: 'status',
      observedAt: 1,
      snapshotId: (old.frames[0] as StatusFrame).snapshotId
    })
  })
})
