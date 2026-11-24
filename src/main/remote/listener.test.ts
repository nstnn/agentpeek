import { createServer } from 'node:http'
import { networkInterfaces } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolHealth } from '../../core/health'
import { REMOTE_LIMITS, type RemoteFrame, type StatusFrame } from '../../core/remote/protocol'
import { REMOTE_SESSION_FIELDS } from '../../core/remote/status-projection'
import type { Session } from '../../core/session'
import { createSnapshot, type SessionsSnapshot } from '../../core/snapshot'
import type { AgentTool } from '../../core/tools'
import { testSession } from '../test-support'
import { accepts, freePort, HOST, OWNER, OWNER_HEADERS, send, subscribe } from './http-test-support'
import { NOTHING_SHARED, type RemoteSharing } from '../../core/remote/share-policy'
import {
  startRemoteListener,
  VIEWER_CSP,
  type RemoteListener,
  type RemoteListenerOptions
} from './listener'
import type { ViewerFiles } from './viewer-files'

// Synthetic data only. Sentinels mark what must never reach a response.
const SHARED = '/Users/synthetic/projects/shared-demo'
const SENTINELS = {
  path: '/Users/sentinel-user/private-root',
  title: 'SENTINEL-TITLE secret plan',
  rawId: 'SENTINEL-RAW-ID',
  version: 'SENTINEL-VERSION-9.9.9'
}

function snapshot(sessions: Session[], takenAt = 1): SessionsSnapshot {
  return createSnapshot({
    sessions,
    health: { codex: { state: 'connected', lastReadAt: 1 }, claude: { state: 'not-installed' } },
    localState: { kind: 'available' },
    firstLaunch: false,
    fixture: true,
    takenAt
  })
}

const sessions = (lastActivityAt = 5): Session[] => [
  testSession({
    key: { tool: 'codex', id: SENTINELS.rawId },
    summary: {
      title: SENTINELS.title,
      workspacePath: SHARED,
      lastActivityAt,
      toolVersion: SENTINELS.version
    }
  }),
  testSession({
    key: { tool: 'claude', id: `${SENTINELS.rawId}-2` },
    summary: {
      title: SENTINELS.title,
      workspacePath: SENTINELS.path,
      lastActivityAt: 6,
      toolVersion: SENTINELS.version
    }
  })
]

const VIEWER: ViewerFiles = {
  page: Buffer.from('<!doctype html><title>AgentPeek</title><div id="root"></div>'),
  assets: new Map([
    ['/assets/index-AbC123.js', { body: Buffer.from('void 0'), type: 'text/javascript' }]
  ])
}

const listeners: RemoteListener[] = []
async function start(change: Partial<RemoteListenerOptions> = {}) {
  const port = change.port ?? (await freePort())
  const result = await startRemoteListener({
    port,
    access: { ownerLogin: OWNER, hostName: HOST },
    secret: new Uint8Array(32).fill(7),
    viewer: VIEWER,
    snapshot: () => snapshot(sessions()),
    sharing: () => ({ sharedWorkspaces: [SHARED], shareTitles: false }),
    generation: () => 0,
    ...change
  })
  if (!result.ok) throw new Error(result.error)
  listeners.push(result.listener)
  return result.listener
}
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(listeners.splice(0).map((listener) => listener.close('shutdown')))
})

const statuses = (frames: RemoteFrame[]) =>
  frames.filter((frame): frame is StatusFrame => frame.type === 'status')

describe('remote listener binding', () => {
  it('listens on 127.0.0.1 at exactly the configured port', async () => {
    const port = await freePort()
    const listener = await start({ port })
    expect(listener.port).toBe(port)
    expect((await send(port)).status).toBe(200)
    // Not on any other interface of this Mac.
    const external = Object.values(networkInterfaces())
      .flat()
      .find((entry) => entry?.family === 'IPv4' && !entry.internal)
    if (external) {
      const reached = await new Promise<boolean>((done) => {
        const probe = createServer()
        probe.once('error', () => done(false))
        // Binding the same port on another interface succeeds only if the listener is not there.
        probe.listen({ host: external.address, port }, () => probe.close(() => done(true)))
      })
      expect(reached).toBe(true)
    }
  })

  it('reports a port in use as a typed error and never falls back to another port', async () => {
    const port = await freePort()
    const other = createServer()
    await new Promise<void>((done) => other.listen({ host: '127.0.0.1', port }, done))
    try {
      const result = await startRemoteListener({
        port,
        access: { ownerLogin: OWNER, hostName: HOST },
        secret: new Uint8Array(32),
        viewer: VIEWER,
        snapshot: () => snapshot([]),
        sharing: () => NOTHING_SHARED,
        generation: () => 0
      })
      expect(result).toEqual({ ok: false, error: 'port-in-use' })
    } finally {
      await new Promise<void>((done) => other.close(() => done()))
    }
    expect(await accepts(port)).toBe(false)
  })
})

describe('remote listener request checks', () => {
  it('gives a missing or other login, a foreign Host or Origin, and other methods no data', async () => {
    // 100 ms a request: the rate limit refills as fast as these requests spend it.
    let clock = 0
    const listener = await start({ now: () => (clock += 100) })
    const port = listener.port
    const refusals: [Record<string, string>, string, number, string?][] = [
      [{ Host: HOST }, 'not-allowed', 403],
      [{ ...OWNER_HEADERS, 'Tailscale-User-Login': 'someone@example.com' }, 'not-allowed', 403],
      [{ ...OWNER_HEADERS, 'Tailscale-User-Login': 'OWNER@example.com' }, 'not-allowed', 403],
      [{ ...OWNER_HEADERS, 'Tailscale-User-Login': `${OWNER}, ${OWNER}` }, 'not-allowed', 403],
      [{ ...OWNER_HEADERS, Host: `127.0.0.1:${port}` }, 'bad-host', 421],
      [{ ...OWNER_HEADERS, Host: 'other-mac.example-tailnet.ts.net' }, 'bad-host', 421],
      [{ ...OWNER_HEADERS, Host: `${HOST}:443` }, 'bad-host', 421],
      [{ ...OWNER_HEADERS, Origin: 'https://evil.example' }, 'bad-origin', 403],
      [{ ...OWNER_HEADERS, Origin: `http://${HOST}` }, 'bad-origin', 403],
      [{ ...OWNER_HEADERS, Origin: 'null' }, 'bad-origin', 403],
      [{ ...OWNER_HEADERS }, 'method-not-allowed', 405, 'POST'],
      [{ ...OWNER_HEADERS }, 'method-not-allowed', 405, 'HEAD'],
      [{ ...OWNER_HEADERS }, 'method-not-allowed', 405, 'OPTIONS']
    ]
    for (const path of ['/v2/status', '/assets/index-AbC123.js']) {
      for (const [headers, error, status, method] of refusals) {
        const reply = await send(port, { path, headers, method })
        expect(reply.status, `${path} ${error}`).toBe(status)
        if (method !== 'HEAD') expect(JSON.parse(reply.body)).toEqual({ v: 2, error })
        expect(reply.headers['content-type']).toBe('application/json')
        expect(reply.headers['cache-control']).toBe('no-store')
        expect(reply.headers.server).toBeUndefined()
        if (error === 'method-not-allowed') expect(reply.headers.allow).toBe('GET')
        expect(Object.keys(reply.headers).some((name) => name.startsWith('access-control-'))).toBe(
          false
        )
        expect(reply.body).not.toContain('event:')
        expect(reply.body).not.toContain(OWNER)
      }
    }
    expect(listener.streamCount()).toBe(0)
  })

  it('answers a refused page request with a fixed page that runs nothing', async () => {
    const { port } = await start()
    const reply = await send(port, { headers: { Host: HOST } })
    expect(reply.status).toBe(403)
    expect(reply.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(reply.headers['content-security-policy']).toMatch(/^default-src 'none'/)
    expect(reply.body).toContain(
      'Not allowed. This page only opens for the Tailscale login set in AgentPeek on the Mac.'
    )
    expect(reply.body).not.toMatch(/<script|<style|<link/)
    const wrongHost = await send(port, { headers: { ...OWNER_HEADERS, Host: 'evil.example' } })
    expect(wrongHost.status).toBe(421)
    expect(wrongHost.body).toContain('Open this page with the Mac address set in AgentPeek.')
  })

  it('serves the viewer page, its hashed assets and nothing else to the owner', async () => {
    const { port } = await start()
    const page = await send(port, { headers: { ...OWNER_HEADERS, Origin: `https://${HOST}` } })
    expect(page.status).toBe(200)
    expect(page.body).toBe(VIEWER.page!.toString())
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(page.headers['cache-control']).toBe('no-store')
    expect(page.headers['content-security-policy']).toBe(VIEWER_CSP)
    expect(page.headers['x-content-type-options']).toBe('nosniff')
    const asset = await send(port, { path: '/assets/index-AbC123.js' })
    expect(asset.status).toBe(200)
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable')
    for (const [path, error] of [
      ['/assets/missing-AbC123.js', 'not-found'],
      ['/assets/../index.html', 'not-found'],
      ['/?x=1', 'not-found'],
      ['/v3/status', 'unsupported-version'],
      ['/events', 'not-found']
    ] as const) {
      expect(JSON.parse((await send(port, { path })).body)).toEqual({ v: 2, error })
    }
  })
})

describe('remote listener status stream', () => {
  it('starts with a complete status of projected fields only', async () => {
    const { port } = await start({ now: () => 1_000 })
    const viewer = subscribe(port)
    await expect.poll(() => viewer.frames.length).toBe(1)
    expect(viewer.response()!.headers['content-type']).toBe('text/event-stream; charset=utf-8')
    expect(viewer.response()!.headers['cache-control']).toBe('no-store')
    const [frame] = statuses(viewer.frames)
    expect(frame).toMatchObject({ v: 2, generation: 0, observedAt: 1, sentAt: 1_000 })
    expect(frame!.status.projects).toHaveLength(1)
    const [row] = frame!.status.projects[0]!.sessions
    expect(Object.keys(row!)).toEqual([...REMOTE_SESSION_FIELDS])
    expect(row!.title).toBe('Session 1')
    const text = viewer.raw.join('')
    for (const sentinel of Object.values(SENTINELS)) expect(text).not.toContain(sentinel)
    expect(text).not.toContain(OWNER)
    expect(text).not.toContain(HOST)
  })

  it('coalesces later statuses to two a second per stream and skips identical ones', async () => {
    let latest = snapshot(sessions(5), 1)
    const listener = await start({ snapshot: () => latest })
    const viewer = subscribe(listener.port)
    await expect.poll(() => viewer.frames.length).toBe(1)
    for (let at = 2; at <= 6; at += 1) {
      latest = snapshot(sessions(at * 10), at)
      listener.publish(latest)
    }
    // Within the first interval nothing more is sent; then only the newest snapshot.
    await new Promise((done) => setTimeout(done, REMOTE_LIMITS.minStatusIntervalMs / 2))
    expect(viewer.frames).toHaveLength(1)
    await expect.poll(() => viewer.frames.length).toBe(2)
    expect(statuses(viewer.frames)[1]!.observedAt).toBe(6)
    listener.publish(latest)
    await new Promise((done) => setTimeout(done, REMOTE_LIMITS.minStatusIntervalMs + 100))
    expect(viewer.frames).toHaveLength(2)
    const [first, second] = statuses(viewer.frames)
    expect(second!.snapshotId).not.toBe(first!.snapshotId)
    expect(second!.sentAt - first!.sentAt).toBeGreaterThanOrEqual(
      REMOTE_LIMITS.minStatusIntervalMs - 5
    )
  })

  it('sends nothing for activity outside the shared folders, and a new status on a new generation', async () => {
    let latest = snapshot(sessions(5), 1)
    let generation = 0
    const listener = await start({ snapshot: () => latest, generation: () => generation })
    const viewer = subscribe(listener.port)
    await expect.poll(() => viewer.frames.length).toBe(1)
    const unshared = testSession({
      key: { tool: 'claude', id: `${SENTINELS.rawId}-2` },
      summary: { ...testSession().summary, workspacePath: SENTINELS.path, lastActivityAt: 99 }
    })
    latest = snapshot([sessions(5)[0]!, unshared], 2)
    listener.publish(latest)
    await new Promise((done) => setTimeout(done, REMOTE_LIMITS.minStatusIntervalMs + 100))
    expect(viewer.frames).toHaveLength(1)
    // A stream that opens now gets the same status: same ID, same time of the last visible change.
    const later = subscribe(listener.port)
    await expect.poll(() => later.frames.length).toBe(1)
    expect(statuses(later.frames)[0]).toMatchObject({
      snapshotId: statuses(viewer.frames)[0]!.snapshotId,
      observedAt: 1
    })
    later.disconnect()
    generation = 1
    listener.publish(latest)
    await expect.poll(() => viewer.frames.length).toBe(2)
    const [first, second] = statuses(viewer.frames)
    expect(second!.generation).toBe(1)
    expect(second!.snapshotId).not.toBe(first!.snapshotId)
    expect(second!.status.projects).toEqual(first!.status.projects)
    // A new generation is a new status, made from the latest snapshot.
    expect(second!.observedAt).toBe(2)
  })

  it('on a policy change, drops the pending send and sends the current policy at once', async () => {
    let latest = snapshot(sessions(5), 1)
    let sharing: RemoteSharing = { sharedWorkspaces: [SHARED], shareTitles: false }
    let generation = 0
    const listener = await start({
      snapshot: () => latest,
      sharing: () => sharing,
      generation: () => generation
    })
    const viewer = subscribe(listener.port)
    await expect.poll(() => viewer.frames.length).toBe(1)
    latest = snapshot(sessions(50), 2)
    listener.publish(latest)
    sharing = NOTHING_SHARED
    generation = 1
    listener.resync()
    await expect.poll(() => viewer.frames.length).toBe(2)
    const [first, replaced] = statuses(viewer.frames)
    expect(replaced!.sentAt - first!.sentAt).toBeLessThan(REMOTE_LIMITS.minStatusIntervalMs)
    expect(replaced).toMatchObject({ generation: 1, observedAt: 2 })
    expect(replaced!.status.projects).toEqual([])
    await new Promise((done) => setTimeout(done, REMOTE_LIMITS.minStatusIntervalMs + 100))
    expect(viewer.frames).toHaveLength(2)
  })

  it('projects again when the policy object changes, even at the same generation', async () => {
    const latest = snapshot(sessions(5), 1)
    let sharing: RemoteSharing = { sharedWorkspaces: [SHARED], shareTitles: false }
    const listener = await start({ snapshot: () => latest, sharing: () => sharing })
    const viewer = subscribe(listener.port)
    await expect.poll(() => viewer.frames.length).toBe(1)
    sharing = NOTHING_SHARED
    listener.publish(latest)
    await expect.poll(() => viewer.frames.length).toBe(2)
    expect(statuses(viewer.frames)[1]!.status.projects).toEqual([])
  })

  it('sends a heartbeat every 15 s with the stream state and the Mac clock', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    let clock = 1_000
    const { port } = await start({ now: () => clock })
    const viewer = subscribe(port)
    await expect.poll(() => viewer.frames.length).toBe(1)
    clock = 16_000
    vi.advanceTimersByTime(REMOTE_LIMITS.heartbeatIntervalMs)
    await expect.poll(() => viewer.frames.length).toBe(2)
    const [status, heartbeat] = viewer.frames as [StatusFrame, RemoteFrame]
    expect(heartbeat).toEqual({
      v: 2,
      type: 'heartbeat',
      snapshotId: status.snapshotId,
      generation: 0,
      sentAt: 16_000
    })
  })

  it('answers a sixth stream with busy', async () => {
    const listener = await start()
    const { port } = listener
    const open = Array.from({ length: REMOTE_LIMITS.maxStreams }, () => subscribe(port))
    await expect.poll(() => open.every((viewer) => viewer.frames.length === 1)).toBe(true)
    const extra = await send(port, { path: '/v2/status' })
    expect(extra.status).toBe(503)
    expect(extra.headers['retry-after']).toBe('5')
    expect(JSON.parse(extra.body)).toEqual({ v: 2, error: 'busy' })
    open[0]!.disconnect()
    await expect.poll(() => listener.streamCount()).toBe(REMOTE_LIMITS.maxStreams - 1)
    const next = subscribe(port)
    await expect.poll(() => next.frames.length).toBe(1)
  })
})

describe('remote listener desktop alias (TASK-042)', () => {
  const sameFolder = (id: string, lastActivityAt: number): Session =>
    testSession({
      key: { tool: 'codex', id },
      summary: { title: SENTINELS.title, workspacePath: SHARED, lastActivityAt, toolVersion: null }
    })
  const list = [sameFolder('synthetic-a', 3), sameFolder('synthetic-b', 4), ...sessions()]

  it('gives each shared session exactly the alias its viewers receive', async () => {
    const listener = await start({ snapshot: () => snapshot(list) })
    const { port } = listener
    const viewer = subscribe(port)
    await expect.poll(() => viewer.frames.length).toBe(1)
    const rows = statuses(viewer.frames)[0]!.status.projects[0]!.sessions
    expect(rows).toHaveLength(3)
    const received = new Set(rows.map((row) => row.title))
    const desktop = new Set(
      ['synthetic-a', 'synthetic-b', SENTINELS.rawId].map((id) =>
        listener.aliasFor({ tool: 'codex', id })
      )
    )
    expect(desktop).toEqual(received)
    expect(received).toEqual(new Set(['Session 1', 'Session 2', 'Session 3']))
  })

  it('has no alias for an unshared session, with titles shared, or after close', async () => {
    let sharing: RemoteSharing = { sharedWorkspaces: [SHARED], shareTitles: false }
    const listener = await start({ snapshot: () => snapshot(list), sharing: () => sharing })
    expect(listener.aliasFor({ tool: 'claude', id: `${SENTINELS.rawId}-2` })).toBeNull()
    expect(listener.aliasFor({ tool: 'codex', id: 'not-listed' })).toBeNull()
    expect(listener.aliasFor({ tool: 'codex', id: 'synthetic-a' })).toMatch(/^Session \d$/)
    sharing = { sharedWorkspaces: [SHARED], shareTitles: true }
    expect(listener.aliasFor({ tool: 'codex', id: 'synthetic-a' })).toBeNull()
    sharing = NOTHING_SHARED
    expect(listener.aliasFor({ tool: 'codex', id: 'synthetic-a' })).toBeNull()
    sharing = { sharedWorkspaces: [SHARED], shareTitles: false }
    await listener.close('remote-off')
    expect(listener.aliasFor({ tool: 'codex', id: 'synthetic-a' })).toBeNull()
  })

  it('renumbers with a new ID secret, as the viewer does', async () => {
    const aliases = async (fill: number) => {
      const listener = await start({
        snapshot: () => snapshot(list),
        secret: new Uint8Array(32).fill(fill)
      })
      return ['synthetic-a', 'synthetic-b', SENTINELS.rawId].map((id) =>
        listener.aliasFor({ tool: 'codex', id })
      )
    }
    const first = await aliases(7)
    let other = first
    for (let fill = 8; fill < 40 && other.join() === first.join(); fill += 1)
      other = await aliases(fill)
    expect(new Set(other)).toEqual(new Set(first))
    expect(other).not.toEqual(first)
  })

  it('reports each stream that opens or ends', async () => {
    const onStreamCount = vi.fn()
    const listener = await start({ onStreamCount })
    const viewer = subscribe(listener.port)
    await expect.poll(() => onStreamCount.mock.calls.length).toBe(1)
    expect(listener.streamCount()).toBe(1)
    viewer.disconnect()
    await expect.poll(() => onStreamCount.mock.calls.length).toBe(2)
    expect(listener.streamCount()).toBe(0)
  })
})

describe('remote listener close', () => {
  it('ends every stream with its reason, drops pending sends and leaves no socket or timer', async () => {
    const timers = () => process.getActiveResourcesInfo().filter((name) => name === 'Timeout')
    const before = timers().length
    let latest = snapshot(sessions(5), 1)
    const listener = await start({ snapshot: () => latest })
    const viewer = subscribe(listener.port)
    await expect.poll(() => viewer.frames.length).toBe(1)
    // A status waits for the coalescing interval when the stream is closed.
    latest = snapshot(sessions(50), 2)
    listener.publish(latest)
    const started = Date.now()
    const closing = listener.close('remote-off')
    listener.publish(snapshot(sessions(60), 3))
    await closing
    await listener.close('remote-off')
    expect(Date.now() - started).toBeLessThan(500)
    await viewer.ended
    expect(viewer.frames.map((frame) => frame.type)).toEqual(['status', 'end'])
    expect(viewer.frames[1]).toEqual({ v: 2, type: 'end', reason: 'remote-off' })
    expect(await accepts(listener.port)).toBe(false)
    expect(timers().length).toBe(before)
    await new Promise((done) => setTimeout(done, REMOTE_LIMITS.minStatusIntervalMs + 100))
    expect(viewer.frames).toHaveLength(2)
  })
})

describe('remote listener ineligible source isolation (CONSTRAINT-004)', () => {
  const ANTIGRAVITY = 'antigravity' as unknown as AgentTool
  const AG_KEY = { tool: ANTIGRAVITY, id: 'SENTINEL-AG-ID' }

  function mixedSnapshot(
    agSessions: Session[],
    agHealth: ToolHealth,
    takenAt: number
  ): SessionsSnapshot {
    const base = snapshot([...sessions(5), ...agSessions], takenAt)
    return {
      ...base,
      health: {
        ...base.health,
        antigravity: agHealth
      } as SessionsSnapshot['health']
    }
  }

  const agSession = (lastActivityAt: number, title = 'SENTINEL-AG-TITLE'): Session =>
    testSession({
      key: AG_KEY,
      summary: {
        title,
        workspacePath: SHARED,
        lastActivityAt,
        toolVersion: '2.34.0'
      },
      activity: { state: 'running' }
    })

  it('excludes Antigravity rows, health, and aliases and ignores Antigravity-only changes', async () => {
    let latest = mixedSnapshot([agSession(50)], { state: 'connected', lastReadAt: 1 }, 1)
    const listener = await start({ snapshot: () => latest })
    const viewer = subscribe(listener.port)
    await expect.poll(() => viewer.frames.length).toBe(1)

    const initial = statuses(viewer.frames)[0]!
    expect(Object.keys(initial.status.sources)).toEqual(['codex', 'claude'])
    expect(initial.status.projects[0]!.sessions).toHaveLength(1)
    expect(initial.status.projects[0]!.sessions[0]!.tool).toBe('codex')
    expect(viewer.raw.join('')).not.toMatch(/antigravity|SENTINEL-AG/)
    expect(listener.aliasFor(AG_KEY)).toBeNull()
    expect(listener.aliasFor({ tool: 'codex', id: SENTINELS.rawId })).toBe('Session 1')

    // Antigravity-only activity, title, and health changes produce no new visible frame.
    latest = mixedSnapshot(
      [agSession(999, 'SENTINEL-AG-UPDATED')],
      { state: 'no-access', lastReadAt: null },
      2
    )
    listener.publish(latest)
    latest = mixedSnapshot([], { state: 'off' }, 3)
    listener.publish(latest)
    await new Promise((done) => setTimeout(done, REMOTE_LIMITS.minStatusIntervalMs + 100))
    expect(viewer.frames).toHaveLength(1)

    // A stream opened afterwards still sees the unchanged snapshotId and observedAt.
    const later = subscribe(listener.port)
    await expect.poll(() => later.frames.length).toBe(1)
    expect(statuses(later.frames)[0]).toMatchObject({
      snapshotId: initial.snapshotId,
      observedAt: 1
    })
    later.disconnect()
  })
})
