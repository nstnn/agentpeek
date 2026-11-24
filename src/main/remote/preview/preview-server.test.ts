import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { request, type IncomingHttpHeaders, type IncomingMessage } from 'node:http'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { RemoteStatus } from '../../../core/remote/status-projection'
import { REMOTE_SESSION_FIELDS } from '../../../core/remote/status-projection'
import type { Session } from '../../../core/session'
import { createSnapshot, type SessionsSnapshot } from '../../../core/snapshot'
import { openSessionsService } from '../../sessions/open-sessions'
import { testService, testSession } from '../../test-support'
import {
  PREVIEW_MIN_INTERVAL_MS,
  PREVIEW_SHARED_WORKSPACES,
  PREVIEW_SWITCH,
  shouldStartPreview,
  startPreviewServer,
  type PreviewServer
} from './preview-server'

// Synthetic data only. Sentinels mark what must never reach the stream.
const SHARED = PREVIEW_SHARED_WORKSPACES[0]
const SENTINELS = {
  path: '/Users/sentinel-user/private-root',
  title: 'SENTINEL-TITLE secret plan',
  rawId: 'SENTINEL-RAW-ID',
  version: 'SENTINEL-VERSION-9.9.9'
}

function snapshot(sessions: Session[], takenAt = 1): SessionsSnapshot {
  return createSnapshot({
    sessions,
    health: {
      codex: { state: 'connected', lastReadAt: 1 },
      claude: { state: 'not-installed' },
      antigravity: { state: 'not-installed' }
    },
    localState: { kind: 'available' },
    firstLaunch: false,
    fixture: true,
    takenAt
  })
}

const sentinelSessions = (): Session[] => [
  testSession({
    key: { tool: 'codex', id: SENTINELS.rawId },
    summary: {
      title: SENTINELS.title,
      workspacePath: SHARED,
      lastActivityAt: 5,
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

interface Reply {
  status: number
  headers: IncomingHttpHeaders
  body: string
}

function send(
  url: string,
  options: { path?: string; method?: string; headers?: Record<string, string> } = {}
): Promise<Reply> {
  return new Promise((done, fail) => {
    const req = request(
      `${url}${options.path ?? '/'}`,
      { method: options.method ?? 'GET', headers: options.headers },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => (body += chunk))
        res.on('end', () => done({ status: res.statusCode ?? 0, headers: res.headers, body }))
      }
    )
    req.on('error', fail)
    req.end()
  })
}

/** Opens the event stream and collects each parsed `status` event. */
function subscribe(url: string, headers: Record<string, string> = {}) {
  const events: RemoteStatus[] = []
  const raw: string[] = []
  let response: IncomingMessage | undefined
  let buffer = ''
  const ended = new Promise<void>((done) => {
    const req = request(`${url}/events`, { headers }, (res) => {
      response = res
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        raw.push(chunk)
        buffer += chunk
        let end: number
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, end)
          buffer = buffer.slice(end + 2)
          expect(frame.split('\n')[0]).toBe('event: status')
          events.push(JSON.parse(frame.split('\n')[1]!.slice('data: '.length)) as RemoteStatus)
        }
      })
      res.on('end', () => done())
      res.on('close', () => done())
    })
    req.on('error', () => done())
    req.end()
  })
  return {
    events,
    raw,
    ended,
    response: () => response,
    disconnect: () => response?.destroy()
  }
}

const servers: PreviewServer[] = []
async function start(sessions: Session[] = sentinelSessions()) {
  const server = await startPreviewServer({ snapshot: () => snapshot(sessions) })
  servers.push(server)
  return server
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

describe('preview switch', () => {
  it('starts only with the switch on a fixture home', () => {
    expect(shouldStartPreview({ [PREVIEW_SWITCH]: '1' }, { fixture: true })).toBe(true)
    expect(shouldStartPreview({}, { fixture: true })).toBe(false)
    expect(shouldStartPreview({ [PREVIEW_SWITCH]: 'true' }, { fixture: true })).toBe(false)
    expect(shouldStartPreview({ [PREVIEW_SWITCH]: '1' }, { fixture: false })).toBe(false)
  })
})

describe('preview server', () => {
  it('listens on 127.0.0.1 only and serves the preview page with the required headers', async () => {
    const server = await start()
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    const page = await send(server.url)
    expect(page.status).toBe(200)
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(page.headers['cache-control']).toBe('no-store')
    const csp = page.headers['content-security-policy']!
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("connect-src 'self'")
    expect(csp).not.toContain('unsafe-inline')
    // The inline script runs only because its hash is listed.
    const script = /<script>([\s\S]*)<\/script>/.exec(page.body)![1]!
    expect(csp).toContain(`'sha256-${createHash('sha256').update(script).digest('base64')}'`)
    // Stream data reaches the page only as text, never as markup.
    expect(script).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/)
    expect(Object.keys(page.headers).some((name) => name.startsWith('access-control-'))).toBe(false)
    expect(page.body).not.toContain(SENTINELS.title)
  })

  it('rejects a foreign Host, a foreign Origin, other methods and other routes', async () => {
    const server = await start()
    const host = server.url.slice('http://'.length)
    const port = host.split(':')[1]!
    for (const path of ['/', '/events']) {
      for (const foreign of [
        'evil.example',
        `localhost:${port}`,
        `evil.example:${port}`,
        '127.0.0.1'
      ]) {
        expect((await send(server.url, { path, headers: { Host: foreign } })).status).toBe(421)
      }
      for (const foreign of ['http://evil.example', `http://localhost:${port}`, 'null']) {
        expect((await send(server.url, { path, headers: { Origin: foreign } })).status).toBe(403)
      }
      for (const method of ['POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS']) {
        const reply = await send(server.url, { path, method })
        expect(reply.status).toBe(405)
        expect(reply.headers.allow).toBe('GET')
      }
    }
    expect((await send(server.url, { headers: { Origin: server.url } })).status).toBe(200)
    expect((await send(server.url, { path: '/other' })).status).toBe(404)
    expect((await send(server.url, { path: '/?x=1' })).status).toBe(404)
  })

  it('streams only projected DTO fields and no path, raw ID, title or version', async () => {
    const server = await start()
    const viewer = subscribe(server.url, { Origin: server.url })
    await expect.poll(() => viewer.events.length).toBe(1)
    expect(viewer.response()!.headers['content-type']).toBe('text/event-stream; charset=utf-8')
    expect(viewer.response()!.headers['cache-control']).toBe('no-store')
    const [status] = viewer.events
    expect(Object.keys(status!).sort()).toEqual(['observedAt', 'omitted', 'projects', 'sources'])
    expect(status!.projects).toHaveLength(1)
    const rows = status!.projects[0]!.sessions
    expect(rows).toHaveLength(1)
    expect(Object.keys(rows[0]!)).toEqual([...REMOTE_SESSION_FIELDS])
    expect(rows[0]!.title).toBe('Session 1')
    const text = viewer.raw.join('')
    for (const sentinel of [...Object.values(SENTINELS), SHARED])
      expect(text).not.toContain(sentinel)
    viewer.disconnect()
  })

  it('coalesces snapshots to at most two a second and sends the latest', async () => {
    const server = await start()
    const viewer = subscribe(server.url)
    await expect.poll(() => viewer.events.length).toBe(1)
    const at = (takenAt: number) => snapshot(sentinelSessions(), takenAt)
    server.publish(at(10))
    for (const takenAt of [11, 12, 13]) server.publish(at(takenAt))
    await expect.poll(() => viewer.events.length).toBe(2)
    expect(viewer.events[1]!.observedAt).toBe(10)
    await new Promise((done) => setTimeout(done, PREVIEW_MIN_INTERVAL_MS + 200))
    expect(viewer.events.map((event) => event.observedAt)).toEqual([1, 10, 13])
    // An unchanged view is not sent again.
    server.publish(at(13))
    await new Promise((done) => setTimeout(done, PREVIEW_MIN_INTERVAL_MS + 100))
    expect(viewer.events).toHaveLength(3)
    viewer.disconnect()
  })

  it('closes the listener, open streams and timers even if a viewer never disconnects', async () => {
    const before = process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length
    const server = await startPreviewServer({ snapshot: () => snapshot(sentinelSessions()) })
    const viewer = subscribe(server.url)
    await expect.poll(() => viewer.events.length).toBe(1)
    server.publish(snapshot(sentinelSessions(), 20))
    server.publish(snapshot(sentinelSessions(), 21)) // leaves a coalescing timer pending
    const started = Date.now()
    await server.close()
    await server.close()
    expect(Date.now() - started).toBeLessThan(500)
    await viewer.ended
    await expect(send(server.url)).rejects.toThrow()
    expect(process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length).toBe(
      before
    )
    server.publish(snapshot(sentinelSessions(), 22))
    expect(viewer.events.at(-1)!.observedAt).not.toBe(22)
  })

  it('never changes read or pin state through the service', async () => {
    const service = testService([
      testSession({ summary: { ...testSession().summary, workspacePath: SHARED } })
    ])
    const before = structuredClone(service.snapshot())
    const server = await startPreviewServer({ snapshot: () => service.snapshot() })
    servers.push(server)
    const viewer = subscribe(server.url)
    await expect.poll(() => viewer.events.length).toBe(1)
    server.publish(service.snapshot())
    viewer.disconnect()
    await viewer.ended
    expect(service.markRead).not.toHaveBeenCalled()
    expect(service.setPinned).not.toHaveBeenCalled()
    expect(service.snapshot()).toEqual(before)
  })
})

interface FixtureModule {
  createFixture: () => Promise<{ home: string; userData: string }>
  removeFixture: (home: string) => Promise<void>
}

async function treeDigest(folder: string): Promise<string> {
  const hash = createHash('sha256')
  const entries = await readdir(folder, { recursive: true, withFileTypes: true })
  for (const entry of entries
    .filter((item) => item.isFile())
    .sort((a, b) => {
      const left = join(a.parentPath, a.name)
      const right = join(b.parentPath, b.name)
      return left < right ? -1 : left > right ? 1 : 0
    })) {
    const path = join(entry.parentPath, entry.name)
    hash.update(path).update(await readFile(path))
  }
  return hash.digest('hex')
}

describe('preview on the synthetic fixture home', () => {
  it('leaves fixture files, state and read/pin state unchanged after a viewer comes and goes', async () => {
    // A runtime path keeps the untyped fixture script out of the type check.
    const fixturePath = pathToFileURL(resolve(__dirname, '../../../../scripts/fixture/home.mjs'))
    const { createFixture, removeFixture } = (await import(fixturePath.href)) as FixtureModule
    const fixture = await createFixture()
    let server: PreviewServer | undefined
    const service = await openSessionsService({
      home: fixture.home,
      stateFolder: fixture.userData,
      fixture: true,
      onSnapshot: (next) => server?.publish(next),
      isCodexAppRunning: () => Promise.resolve(true),
      isAntigravityAppRunning: () => Promise.resolve(true),
      probe: { isAlive: () => Promise.resolve(true) }
    })
    try {
      await service.start()
      await expect
        .poll(() => service.snapshot().sessions.length, { timeout: 10_000 })
        .toBeGreaterThan(0)
      // The first-start baselines are saved shortly after the first reads. Wait for that save, so
      // the comparison covers only what the viewer could change.
      await expect
        .poll(
          () =>
            stat(join(fixture.userData, 'state.json')).then(
              () => true,
              () => false
            ),
          {
            timeout: 10_000
          }
        )
        .toBe(true)
      const marks = () =>
        service.snapshot().sessions.map((session) => [session.attention, session.pinned])
      const before = {
        home: await treeDigest(fixture.home),
        state: await treeDigest(fixture.userData),
        marks: marks()
      }
      server = await startPreviewServer({ snapshot: () => service.snapshot() })
      const viewer = subscribe(server.url)
      await expect.poll(() => viewer.events.length).toBeGreaterThan(0)
      const rows = viewer.events[0]!.projects.flatMap((project) => project.sessions)
      expect(rows.length).toBeGreaterThan(0)
      // Fixture titles all start with "Fixture"; titles are not shared. The folder name may appear.
      expect(viewer.raw.join('')).not.toMatch(/Fixture |\/Users\/synthetic|agentpeek-fixture-/)
      viewer.disconnect()
      await viewer.ended
      await server.close()
      expect({
        home: await treeDigest(fixture.home),
        state: await treeDigest(fixture.userData),
        marks: marks()
      }).toEqual(before)
    } finally {
      await server?.close()
      await service.stop()
      await removeFixture(fixture.home)
    }
  }, 20_000)
})
