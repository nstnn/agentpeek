/// <reference lib="dom" />
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from '@playwright/test'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { EndReason } from '../../../src/core/remote/protocol'
import type { Session } from '../../../src/core/session'
import { createSnapshot } from '../../../src/core/snapshot'
import { freePort, HOST, OWNER } from '../../../src/main/remote/http-test-support'
import { startRemoteListener, type RemoteListener } from '../../../src/main/remote/listener'
import { loadViewerFiles, type ViewerFiles } from '../../../src/main/remote/viewer-files'
import { testSession } from '../../../src/main/test-support'

// The built viewer page in headless Chrome (no window), against the real listener, through a
// simulated Serve: a loopback proxy that drops client-supplied Tailscale headers, adds the login it
// is told to, and sends the Mac address as Host, as `tailscale serve` does. Synthetic data only:
// invented logins and folders. Sentinels mark what must never reach the page.

const repo = join(import.meta.dirname, '../../..')
const SHARED = '/Users/synthetic/projects/shared-demo'
const LATER = '/Users/synthetic/projects/later-demo'
const SENTINEL_TITLE = 'SENTINEL-TITLE secret plan'
const OTHER_LOGIN = 'someone-else@example.com'

const sessions = (folders: string[]): Session[] =>
  folders.map((workspacePath, index) =>
    testSession({
      key: { tool: 'codex', id: `SENTINEL-RAW-ID-${index}` },
      summary: {
        title: SENTINEL_TITLE,
        workspacePath,
        lastActivityAt: 5 + index,
        toolVersion: 'SENTINEL-VERSION-9.9.9'
      }
    })
  )

const snapshotOf = (folders: string[], list = sessions(folders)) =>
  createSnapshot({
    sessions: list,
    health: { codex: { state: 'connected', lastReadAt: 1 }, claude: { state: 'not-installed' } },
    localState: { kind: 'available' },
    firstLaunch: false,
    fixture: true,
    takenAt: 1
  })

/** What the simulated Serve adds, and whether it counts the requests that reach it. */
interface Serve {
  port: number
  login: string | null
  host: string
  requests: string[]
  server: Server
}

async function startServe(listenerPort: () => number): Promise<Serve> {
  const serve: Serve = { port: 0, login: OWNER, host: HOST, requests: [], server: createServer() }
  serve.server.on('request', (incoming, outgoing) => {
    serve.requests.push(incoming.url ?? '')
    const headers: IncomingHttpHeaders = {}
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (!name.startsWith('tailscale-') && name !== 'host' && name !== 'origin') {
        headers[name] = value
      }
    }
    headers.host = serve.host
    if (incoming.headers.origin !== undefined) headers.origin = `https://${serve.host}`
    if (serve.login !== null) headers['tailscale-user-login'] = serve.login
    const upstream = request(
      {
        host: '127.0.0.1',
        port: listenerPort(),
        path: incoming.url,
        method: incoming.method,
        headers
      },
      (reply) => {
        outgoing.writeHead(reply.statusCode ?? 502, reply.headers)
        reply.pipe(outgoing)
      }
    )
    // What Serve answers while nothing listens behind it: its own error, not AgentPeek's.
    upstream.on('error', () => {
      if (outgoing.headersSent) return outgoing.destroy()
      outgoing.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
      outgoing.end('Bad Gateway')
    })
    outgoing.on('close', () => upstream.destroy())
    incoming.pipe(upstream)
  })
  await new Promise<void>((done) => serve.server.listen({ host: '127.0.0.1', port: 0 }, done))
  serve.port = (serve.server.address() as AddressInfo).port
  return serve
}

let viewer: ViewerFiles
let browser: Browser
let listenerPort = 0
let listener: RemoteListener | null = null
let serve: Serve

async function startListener(folders = [SHARED], list?: Session[]): Promise<void> {
  const result = await startRemoteListener({
    port: listenerPort,
    access: { ownerLogin: OWNER, hostName: HOST },
    secret: new Uint8Array(32).fill(7),
    viewer,
    snapshot: () => snapshotOf(folders, list),
    sharing: () => ({ sharedWorkspaces: folders, shareTitles: false }),
    generation: () => 0
  })
  if (!result.ok) throw new Error(result.error)
  listener = result.listener
}

async function stopListener(reason: EndReason): Promise<void> {
  await listener?.close(reason)
  listener = null
}

async function openPage(viewport?: { width: number; height: number }): Promise<Page> {
  const context = await browser.newContext(viewport ? { viewport } : {})
  const page = await context.newPage()
  // Short, still jittered waits, so a reconnect takes well under a second in this test.
  await page.addInitScript(() => {
    Math.random = () => 0.05
  })
  await page.goto(`http://127.0.0.1:${serve.port}/`)
  loadedHistory.set(page, await page.evaluate(() => history.length))
  return page
}

/** History length right after the load: a new tab starts at about:blank, which counts. */
const loadedHistory = new WeakMap<Page, number>()

const pill = (page: Page) => page.getByRole('status')
const statusRequests = () => serve.requests.filter((path) => path === '/v1/status').length

/** Everything a browser could keep after the page: storage, cookies, caches, history. */
async function kept(page: Page) {
  const stored = await page.evaluate(async () => ({
    local: localStorage.length,
    session: sessionStorage.length,
    cookies: document.cookie,
    databases: (await indexedDB.databases()).length,
    caches: (await caches.keys()).length,
    history: history.length
  }))
  return { ...stored, history: stored.history - loadedHistory.get(page)! }
}

/** Nothing stored, and no history entry added since the load. */
const NOTHING_KEPT = { local: 0, session: 0, cookies: '', databases: 0, caches: 0, history: 0 }

beforeAll(async () => {
  viewer = await loadViewerFiles(join(repo, 'out/remote-web'))
  if (!viewer.page) throw new Error('Build the viewer first: npm run build:remote-web')
  browser = await chromium.launch({ channel: 'chrome', headless: true })
})

afterAll(async () => {
  await browser?.close()
})

describe('Remote View connection entry in a browser', () => {
  beforeAll(async () => {
    listenerPort = await freePort()
    serve = await startServe(() => listenerPort)
  })

  afterEach(async () => {
    for (const context of browser.contexts()) await context.close()
    await stopListener('shutdown')
    serve.login = OWNER
    serve.host = HOST
    serve.requests.length = 0
  })

  afterAll(async () => {
    await new Promise<void>((done) => serve.server.close(() => done()))
  })

  it('the owner login and Mac address reach Live with only projected data', async () => {
    await startListener()
    const page = await openPage()
    await expect.poll(() => pill(page).textContent()).toBe('Live')
    await page.getByRole('heading', { level: 2, name: 'shared-demo' }).waitFor()
    const text = await page.locator('body').innerText()
    expect(text).not.toContain(SENTINEL_TITLE)
    expect(text).not.toContain('/Users/')
    expect(text).not.toContain(OWNER)
    expect(await kept(page)).toEqual(NOTHING_KEPT)
  })

  it.each([
    ['missing', null],
    ['different', OTHER_LOGIN]
  ])('a %s login gets the fixed Not allowed page, no data and no retry', async (_, login) => {
    await startListener()
    serve.login = login
    const page = await openPage()
    await page
      .getByText(
        'Not allowed. This page only opens for the Tailscale login set in AgentPeek on the Mac.'
      )
      .waitFor()
    expect(await page.locator('script').count()).toBe(0)
    expect(await page.locator('body').innerText()).not.toContain('shared-demo')
    await page.waitForTimeout(1500)
    expect(serve.requests).toEqual(['/'])
  })

  it('a foreign Host gets the fixed wrong-address page', async () => {
    await startListener()
    serve.host = 'other-mac.example-tailnet.ts.net'
    const page = await openPage()
    await page.getByText('Open this page with the Mac address set in AgentPeek.').waitFor()
    expect(await page.locator('script').count()).toBe(0)
    expect(await page.locator('body').innerText()).not.toContain('shared-demo')
  })

  it('an open page whose login is no longer allowed clears its data and stops retrying', async () => {
    await startListener()
    const page = await openPage()
    await page.getByRole('heading', { level: 2, name: 'shared-demo' }).waitFor()
    serve.login = OTHER_LOGIN
    await stopListener('access-changed')
    await startListener()
    await page
      .getByText(
        'Not allowed. This page only opens for the Tailscale login set in AgentPeek on the Mac.'
      )
      .waitFor()
    expect(await page.getByTestId('status').count()).toBe(0)
    expect(await page.locator('body').innerText()).not.toContain('shared-demo')
    const asked = statusRequests()
    await page.waitForTimeout(3000)
    expect(statusRequests()).toBe(asked)
    expect(await kept(page)).toEqual(NOTHING_KEPT)
  })

  it('an open page reached from a foreign Host shows the wrong-address state', async () => {
    await startListener()
    const page = await openPage()
    await page.getByRole('heading', { level: 2, name: 'shared-demo' }).waitFor()
    serve.host = 'other-mac.example-tailnet.ts.net'
    await stopListener('access-changed')
    await startListener()
    await page.getByText('Open this page with the Mac address set in AgentPeek.').waitFor()
    expect(await page.getByTestId('status').count()).toBe(0)
    const asked = statusRequests()
    await page.waitForTimeout(2000)
    expect(statusRequests()).toBe(asked)
  })

  it('a stopped listener shows disconnected, and a restart reconnects with a full status', async () => {
    await startListener()
    const page = await openPage()
    await page.getByRole('heading', { level: 2, name: 'shared-demo' }).waitFor()
    await stopListener('shutdown')
    // Reconnecting first, then lost after repeated Serve errors; the old data stays, dimmed.
    await expect.poll(() => pill(page).textContent()).toBe('Connection lost')
    expect(await page.locator('.pill').innerText()).toMatch(/showing data from/)
    expect(await page.locator('.status.dimmed').count()).toBe(1)
    await page.getByText('AgentPeek may be closed, or the Mac asleep or offline.').waitFor()
    await page.getByText(/Tailscale shows its own error page/).waitFor()

    await startListener([SHARED, LATER])
    await expect.poll(() => pill(page).textContent(), { timeout: 15_000 }).toBe('Live')
    await page.getByRole('heading', { level: 2, name: 'later-demo' }).waitFor()
    expect(await page.locator('.status.dimmed').count()).toBe(0)
    expect(await kept(page)).toEqual(NOTHING_KEPT)
  })

  it('Remote View turned off clears the list and reconnects when it is on again', async () => {
    await startListener()
    const page = await openPage()
    await page.getByRole('heading', { level: 2, name: 'shared-demo' }).waitFor()
    await stopListener('remote-off')
    await expect.poll(() => pill(page).textContent()).toBe('Remote View is off')
    expect(await page.getByTestId('status').count()).toBe(0)
    await page.getByText('Remote View was turned off on the Mac.').waitFor()
    await startListener()
    await expect.poll(() => pill(page).textContent(), { timeout: 15_000 }).toBe('Live')
  })
})

describe('Remote View session list in a browser', () => {
  // Both tools, two projects and every attention kind, so the filters and the attention group show.
  const mixed = (): Session[] => [
    testSession({
      key: { tool: 'claude', id: 'SENTINEL-RAW-ID-wait' },
      summary: {
        title: SENTINEL_TITLE,
        workspacePath: SHARED,
        lastActivityAt: 30,
        toolVersion: '1'
      },
      activity: { state: 'waiting', waitingFor: 'permission prompt' },
      attention: { waiting: true, newReply: false, error: false }
    }),
    testSession({
      key: { tool: 'codex', id: 'SENTINEL-RAW-ID-reply' },
      summary: {
        title: SENTINEL_TITLE,
        workspacePath: LATER,
        lastActivityAt: 20,
        toolVersion: '1'
      },
      attention: { waiting: false, newReply: true, error: false }
    }),
    testSession({
      key: { tool: 'codex', id: 'SENTINEL-RAW-ID-run' },
      summary: {
        title: SENTINEL_TITLE,
        workspacePath: SHARED,
        lastActivityAt: 10,
        toolVersion: '1'
      },
      activity: { state: 'running' }
    }),
    testSession({
      key: { tool: 'claude', id: 'SENTINEL-RAW-ID-idle' },
      summary: { title: SENTINEL_TITLE, workspacePath: LATER, lastActivityAt: 5, toolVersion: '1' }
    })
  ]

  beforeAll(async () => {
    listenerPort = await freePort()
    serve = await startServe(() => listenerPort)
  })

  afterEach(async () => {
    for (const context of browser.contexts()) await context.close()
    await stopListener('shutdown')
    serve.requests.length = 0
  })

  afterAll(async () => {
    await new Promise<void>((done) => serve.server.close(() => done()))
  })

  it('fits a 320-pixel viewport with no horizontal scroll and wrapped rows', async () => {
    await startListener([SHARED, LATER], mixed())
    const page = await openPage({ width: 320, height: 640 })
    await page.getByRole('heading', { level: 2, name: 'Needs attention' }).waitFor()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320)
    const row = page.locator('.row').first()
    const title = await row.locator('.row-title').boundingBox()
    const state = await row.locator('.row-state').boundingBox()
    expect(state!.y).toBeGreaterThan(title!.y + title!.height - 1)
    for (const select of await page.locator('select').all()) {
      expect((await select.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    }
    const text = await page.locator('body').innerText()
    expect(text).toContain('Waiting for you · Permission')
    expect(text).toContain('1 needs you · 1 new reply')
    expect(text).not.toContain(SENTINEL_TITLE)
    expect(text).not.toContain('SENTINEL-RAW-ID')
    await page.screenshot({ path: join(repo, 'test-results/remote-list-320.png'), fullPage: true })
  })

  it('works from the keyboard and sends nothing but the status stream', async () => {
    await startListener([SHARED, LATER], mixed())
    const page = await openPage({ width: 1024, height: 768 })
    await page.getByRole('heading', { level: 2, name: 'Needs attention' }).waitFor()
    const rowsBefore = await page.locator('.row').count()
    expect(rowsBefore).toBe(4)

    // Rows are not focusable: the first Tab stop is the Project filter, the next the Tool filter.
    await page.keyboard.press('Tab')
    expect(await page.evaluate(() => document.activeElement?.id)).toBe(
      await page.getByLabel('Project').getAttribute('id')
    )
    await page.keyboard.type('later')
    await expect.poll(() => page.getByLabel('Project').inputValue()).toBe('later-demo')
    expect(await page.locator('.row').count()).toBe(2)
    expect(await page.getByRole('heading', { level: 2, name: 'shared-demo' }).count()).toBe(0)

    await page.keyboard.press('Tab')
    expect(await page.evaluate(() => document.activeElement?.id)).toBe(
      await page.getByLabel('Tool').getAttribute('id')
    )
    await page.keyboard.type('claude')
    await expect.poll(() => page.locator('.row').count()).toBe(1)
    expect(await page.locator('.row').innerText()).toContain('Idle')
    await page.screenshot({ path: join(repo, 'test-results/remote-list-1024.png'), fullPage: true })

    expect(await page.evaluate(() => location.pathname + location.search + location.hash)).toBe('/')
    expect(await kept(page)).toEqual(NOTHING_KEPT)
    const paths = serve.requests.map((path) => (path.startsWith('/assets/') ? '/assets/' : path))
    expect([...new Set(paths)].sort()).toEqual(['/', '/assets/', '/v1/status'])
    expect(statusRequests()).toBe(1)
  })
})
