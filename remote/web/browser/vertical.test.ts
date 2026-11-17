/// <reference lib="dom" />
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { chromium, type Browser } from '@playwright/test'
import { expect, it, vi } from 'vitest'
import { createSessionController } from '../../../src/main/session-controller'
import { openSessionsService } from '../../../src/main/sessions/open-sessions'
import type { SessionsService } from '../../../src/main/sessions/service'
import { testSystem } from '../../../src/main/test-support'
import {
  accepts,
  freePort,
  HOST,
  OWNER,
  OWNER_HEADERS,
  send,
  subscribe
} from '../../../src/main/remote/http-test-support'
import { createRemoteView, type RemoteView } from '../../../src/main/remote/remote-view'

// TASK-023: real allowlisted readers -> service -> saved sharing policy -> listener -> two
// production viewer pages. All files and identities are invented; no Electron or real tool home.
const repo = join(import.meta.dirname, '../../..')
const execute = promisify(execFile)
const fixtureCommand = async (...args: string[]): Promise<unknown> =>
  JSON.parse(
    (await execute(process.execPath, [join(repo, 'scripts/fixture/index.mjs'), ...args])).stdout
  )
const workspace = '/Users/synthetic/projects/fixture-demo'

async function digestTree(folder: string, prefix = ''): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const name = `${prefix}${entry.name}`
    const path = join(folder, entry.name)
    if (entry.isDirectory()) Object.assign(result, await digestTree(path, `${name}/`))
    else {
      expect(entry.isFile()).toBe(true)
      result[name] = createHash('sha256')
        .update(await readFile(path))
        .digest('hex')
    }
  }
  return result
}

it('proves the local vertical journey with real fixture readers and two viewer pages', async () => {
  const fixture = (await fixtureCommand('create')) as { home: string; userData: string }
  const evidenceFolder = join(repo, 'test-results/remote-vertical')
  await mkdir(evidenceFolder, { recursive: true })
  const checks: string[] = []
  const evidence: Record<string, unknown> = { completed: false, checks, cleanup: null }
  let service: SessionsService | undefined
  let remote: RemoteView | undefined
  let browser: Browser | undefined
  let port = 0
  let proxyLogin = OWNER
  const requests: string[] = []
  const proxy = createServer((incoming, outgoing) => {
    requests.push(incoming.url ?? '')
    const upstream = request(
      {
        host: '127.0.0.1',
        port,
        path: incoming.url,
        method: incoming.method,
        headers: { Host: HOST, 'Tailscale-User-Login': proxyLogin }
      },
      (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers)
        response.pipe(outgoing)
        response.on('error', () => outgoing.destroy())
      }
    )
    upstream.on('error', () => {
      if (outgoing.headersSent) outgoing.destroy()
      else outgoing.writeHead(502).end('Bad Gateway')
    })
    outgoing.on('close', () => upstream.destroy())
    incoming.pipe(upstream)
  })
  const streams: ReturnType<typeof subscribe>[] = []
  try {
    // Give three listed sessions distinct unshared scopes: child, worktree and another project.
    for (const [i, cwd] of [
      `${workspace}/child`,
      `${workspace}-worktree`,
      '/Users/synthetic/projects/unshared-demo'
    ].entries()) {
      const id = `00000000-0000-4000-8000-${(200 + i).toString(16).padStart(12, '0')}`
      const path = join(
        fixture.home,
        '.codex/sessions/2026/01/15',
        `rollout-2026-01-15T09-00-00-${id}.jsonl`
      )
      const lines = (await readFile(path, 'utf8')).trimEnd().split('\n')
      const metadata = JSON.parse(lines[0]!) as { payload: { cwd: string } }
      metadata.payload.cwd = cwd
      lines[0] = JSON.stringify(metadata)
      await writeFile(path, `${lines.join('\n')}\n`)
    }
    service = await openSessionsService({
      home: fixture.home,
      stateFolder: fixture.userData,
      fixture: true,
      isCodexAppRunning: () => Promise.resolve(true),
      probe: { isAlive: () => Promise.resolve(true) },
      onSnapshot: (snapshot) => remote?.publish(snapshot)
    })
    await service.start()
    await expect.poll(() => service!.snapshot().sessions.length).toBe(100)
    const initialFiles = await digestTree(fixture.home)
    port = await freePort()
    const openRemote = () =>
      createRemoteView({
        folder: fixture.userData,
        viewerFolder: join(repo, 'out/remote-web'),
        snapshot: () => service!.snapshot()
      })
    remote = openRemote()
    await remote.open()
    expect(remote.status().state).toBe('off')
    expect(await accepts(port)).toBe(false)
    expect(await remote.saveConnection({ ownerLogin: OWNER, hostName: HOST, port })).toEqual({
      ok: true
    })
    expect(await accepts(port)).toBe(false)
    expect(await remote.enable()).toEqual({ ok: true })
    checks.push('A01: fresh and configured OFF have no listener; explicit enable succeeds')

    await new Promise<void>((done) => proxy.listen(0, '127.0.0.1', done))
    const url = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}/`
    browser = await chromium.launch({ channel: 'chrome', headless: true })
    const context = await browser.newContext()
    const pages = await Promise.all([context.newPage(), context.newPage()])
    for (const page of pages) {
      await page.addInitScript(() => {
        Math.random = () => 0.05
      })
      await page.goto(url)
    }
    const bodies = () => Promise.all(pages.map((page) => page.locator('body').innerText()))
    const rowsAre = async (count: number) =>
      (await Promise.all(pages.map((page) => page.locator('.rows > li').count()))).every(
        (n) => n === count
      )
    await expect
      .poll(async () =>
        (await bodies()).every(
          (text) => text.includes('Live') && text.includes('No projects are shared')
        )
      )
      .toBe(true)
    expect(await remote.shareWorkspace(workspace)).toEqual({ ok: true })
    await expect
      .poll(async () => (await bodies()).every((text) => text.includes('fixture-demo')))
      .toBe(true)
    // Every shared session, idle ones included: the All Sessions view in the sidebar.
    for (const page of pages) await page.getByRole('button', { name: /^All Sessions/ }).click()
    await expect.poll(() => rowsAre(97)).toBe(true)
    expect(
      (await bodies()).every((text) => !text.includes('Fixture Codex') && !text.includes('/Users/'))
    ).toBe(true)
    expect(await digestTree(fixture.home)).toEqual(initialFiles)
    checks.push(
      'A02/A05: two live pages; empty scope then 97 exact-folder sessions; child/worktree/other project excluded; aliases; no tool writes'
    )

    const selected = service.snapshot().sessions.find((session) => session.key.tool === 'claude')!
    service.setPinned(selected.key, true)
    const controller = createSessionController({
      service,
      system: testSystem(),
      fixtureHome: fixture.home,
      reload: async () => {},
      command: () => {},
      updateMenu: () => {},
      popup: () => {},
      isFocused: () => false
    })
    controller.setSelection(selected.key)
    // A fresh fixture has no state file until the first baseline save has drained.
    await expect
      .poll(async () =>
        (
          JSON.parse(await readFile(join(fixture.userData, 'state.json'), 'utf8')) as {
            sessions: { pinned: boolean }[]
          }
        ).sessions.some((entry: { pinned: boolean }) => entry.pinned)
      )
      .toBe(true)
    await fixtureCommand('simulate', fixture.home, 'codex-complete')
    await expect
      .poll(() =>
        service!
          .snapshot()
          .sessions.some((session) => session.key.tool === 'codex' && session.attention.newReply)
      )
      .toBe(true)
    await expect
      .poll(async () => (await bodies()).every((text) => text.includes('New reply')))
      .toBe(true)
    // Start read-only comparisons after the deliberate simulator write and local pin have settled.
    const toolFiles = await digestTree(fixture.home)
    const localFlags = () =>
      service!.snapshot().sessions.map(({ key, pinned, attention, lastReply }) => ({
        key,
        pinned,
        attention,
        lastReply
      }))
    const flags = structuredClone(localFlags())
    const actionSpies = ['markRead', 'setPinned', 'recentMessages', 'getSkill'].map((name) =>
      vi.spyOn(service!, name as 'markRead')
    )
    const stateBefore = await readFile(join(fixture.userData, 'state.json'), 'utf8')
    for (const page of pages) {
      await page.getByRole('button', { name: /^Codex, / }).click()
      await page.screenshot({ path: join(evidenceFolder, `viewer-${pages.indexOf(page) + 1}.png`) })
      expect(
        await page.evaluate(async () => ({
          local: localStorage.length,
          session: sessionStorage.length,
          cookies: document.cookie,
          caches: (await caches.keys()).length,
          databases: (await indexedDB.databases()).length
        }))
      ).toEqual({ local: 0, session: 0, cookies: '', caches: 0, databases: 0 })
    }
    expect(controller.selected()?.key).toEqual(selected.key)
    expect(localFlags()).toEqual(flags)
    expect(await readFile(join(fixture.userData, 'state.json'), 'utf8')).toBe(stateBefore)
    for (const spy of actionSpies) {
      expect(spy).not.toHaveBeenCalled()
      spy.mockRestore()
    }
    checks.push(
      'A05/A09: simulator change reaches both pages; filters do not select, read, pin, request messages or persist browser data'
    )

    const guards: {
      headers: Record<string, string>
      status: number
      error: string
      method?: string
    }[] = [
      { headers: { Host: HOST }, status: 403, error: 'not-allowed' },
      {
        headers: { ...OWNER_HEADERS, 'Tailscale-User-Login': 'other@example.com' },
        status: 403,
        error: 'not-allowed'
      },
      { headers: {}, status: 403, error: 'not-allowed' },
      { headers: { ...OWNER_HEADERS, Host: 'foreign.example' }, status: 421, error: 'bad-host' },
      {
        headers: { ...OWNER_HEADERS, Origin: 'https://foreign.example' },
        status: 403,
        error: 'bad-origin'
      },
      { method: 'POST', headers: { ...OWNER_HEADERS }, status: 405, error: 'method-not-allowed' }
    ]
    for (const guard of guards) {
      const reply = await send(port, { ...guard, path: '/v2/status' })
      expect(reply.status).toBe(guard.status)
      expect(JSON.parse(reply.body)).toEqual({ v: 2, error: guard.error })
      expect(reply.headers['cache-control']).toBe('no-store')
    }
    checks.push(
      'A03/A04: no login, wrong login, direct loopback, foreign Host/Origin and POST fail closed'
    )

    // Three additional protocol clients fill the cap beside the two browser tabs.
    for (let i = 0; i < 3; i++) {
      const stream = subscribe(port)
      streams.push(stream)
      await expect.poll(() => stream.frames.length).toBeGreaterThan(0)
    }
    expect((await send(port, { path: '/v2/status' })).status).toBe(503)
    for (const stream of streams.splice(0)) stream.disconnect()
    await expect
      .poll(() => {
        const status = remote!.status()
        return status.state === 'on' ? status.streams : -1
      })
      .toBe(2)
    checks.push('A04: sixth stream rejected; healthy browser streams remain')

    // Restore All tools through the page before checking the source scope.
    for (const page of pages) await page.getByRole('button', { name: /^All, / }).click()
    // The Claude session pinned above no longer counts toward the 50-session cap, so the rescan
    // after a source change lists one more Claude session: 50 + 1 pinned, then 98 with Codex.
    await service.setSourceEnabled('codex', false)
    await expect.poll(() => rowsAre(51)).toBe(true)
    expect((await bodies()).every((text) => !text.includes('New reply'))).toBe(true)
    await service.setSourceEnabled('codex', true)
    await expect.poll(() => rowsAre(98)).toBe(true)
    expect(await remote.unshareWorkspace(workspace)).toEqual({ ok: true })
    await expect
      .poll(async () =>
        (await bodies()).every(
          (text) => !text.includes('fixture-demo') && text.includes('No projects are shared')
        )
      )
      .toBe(true)
    expect(await remote.shareWorkspace(workspace)).toEqual({ ok: true })
    await expect.poll(() => rowsAre(98)).toBe(true)
    checks.push(
      'A06: source OFF clears Codex on both pages; folder removal clears all rows; widening restores full state'
    )

    const old = subscribe(port)
    streams.push(old)
    await expect.poll(() => old.frames.length).toBe(1)
    const first = old.frames[0]!
    expect(first.type).toBe('status')
    const newLogin = 'next-owner@example.com'
    expect(await remote.saveConnection({ ownerLogin: newLogin, hostName: HOST, port })).toEqual({
      ok: true
    })
    await old.ended
    expect(old.frames.at(-1)).toMatchObject({ type: 'end', reason: 'access-changed' })
    await expect
      .poll(async () =>
        (await bodies()).every(
          (text) => text.includes('Not allowed') && !text.includes('fixture-demo')
        )
      )
      .toBe(true)
    expect((await send(port, { path: '/v2/status' })).status).toBe(403)
    const next = subscribe(port, { ...OWNER_HEADERS, 'Tailscale-User-Login': newLogin })
    streams.push(next)
    await expect.poll(() => next.frames.length).toBe(1)
    const second = next.frames[0]!
    if (first.type !== 'status' || second.type !== 'status')
      throw new Error('Expected full statuses')
    const ids = new Set(
      first.status.projects.flatMap((project) => project.sessions.map((session) => session.id))
    )
    expect(
      second.status.projects
        .flatMap((project) => project.sessions)
        .every((session) => !ids.has(session.id))
    ).toBe(true)
    next.disconnect()
    proxyLogin = newLogin
    for (const page of pages) await page.reload()
    await expect
      .poll(async () => (await bodies()).every((text) => text.includes('Live')))
      .toBe(true)
    checks.push(
      'A14: login change ends old stream, clears/refuses old pages, rotates all IDs; new login loads full state'
    )

    expect(await remote.disable()).toEqual({ ok: true })
    await expect
      .poll(async () =>
        (await bodies()).every(
          (text) => text.includes('Remote View is off') && !text.includes('fixture-demo')
        )
      )
      .toBe(true)
    expect(await accepts(port)).toBe(false)
    expect(await remote.enable()).toEqual({ ok: true })
    await expect
      .poll(async () => (await bodies()).every((text) => text.includes('Live')))
      .toBe(true)
    const quitting = subscribe(port, { ...OWNER_HEADERS, 'Tailscale-User-Login': newLogin })
    streams.push(quitting)
    await expect.poll(() => quitting.frames.length).toBe(1)
    await remote.close()
    await quitting.ended
    expect(quitting.frames.at(-1)).toMatchObject({ type: 'end', reason: 'shutdown' })
    expect(await accepts(port)).toBe(false)
    await expect
      .poll(async () => (await bodies()).every((text) => text.includes('Connection lost')))
      .toBe(true)
    remote = openRemote()
    await remote.open()
    await expect
      .poll(async () => (await bodies()).every((text) => text.includes('Live')))
      .toBe(true)
    checks.push(
      'A06/A07: OFF clears; enable reconnects; shutdown ends streams and port; saved ON reopens and pages resync'
    )
    expect(await digestTree(fixture.home)).toEqual(toolFiles)
    expect(controller.selected()?.key).toEqual(selected.key)
    expect(localFlags()).toEqual(flags)
    const settings = JSON.parse(
      await readFile(join(fixture.userData, 'remote-view.json'), 'utf8')
    ) as Record<string, unknown>
    expect(Object.keys(settings).sort()).toEqual(
      [
        'version',
        'enabled',
        'ownerLogin',
        'hostName',
        'port',
        'sharedWorkspaces',
        'shareTitles'
      ].sort()
    )
    expect(
      requests.every(
        (path) =>
          path === '/' ||
          path === '/v2/status' ||
          path === '/favicon.ico' ||
          path.startsWith('/assets/')
      )
    ).toBe(true)
    evidence.requests = requests
    checks.push(
      'A05/A09: final tool hashes and local selection/pin/read/error flags unchanged; only approved settings persisted'
    )
    evidence.completed = true
  } finally {
    vi.restoreAllMocks()
    for (const stream of streams) stream.disconnect()
    const cleanup = await Promise.allSettled([
      browser?.close(),
      remote?.close(),
      service?.stop(),
      new Promise<void>((done) => {
        proxy.closeAllConnections()
        proxy.close(() => done())
      })
    ])
    const portClosed = port === 0 || !(await accepts(port))
    const serviceStopped = cleanup[2].status === 'fulfilled'
    let fixtureRemoved = false
    if (serviceStopped) {
      await fixtureCommand('clean', fixture.home)
      fixtureRemoved = true
    }
    evidence.cleanup = {
      browserClosed: !browser?.isConnected(),
      listenerClosed: portClosed,
      proxyClosed: !proxy.listening,
      fixtureRemoved,
      serviceStopped
    }
    await writeFile(join(evidenceFolder, 'evidence.json'), JSON.stringify(evidence, null, 2))
    expect(cleanup.every((result) => result.status === 'fulfilled')).toBe(true)
    expect(portClosed).toBe(true)
  }
}, 60_000)
