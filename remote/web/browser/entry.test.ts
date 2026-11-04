/// <reference lib="dom" />
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
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
      },
      // Running, so the default Active view lists them.
      activity: { state: 'running' }
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
  silent: boolean
  sent: { observedAt: number; sentAt: number }[]
}

async function startServe(listenerPort: () => number): Promise<Serve> {
  const serve: Serve = {
    port: 0,
    login: OWNER,
    host: HOST,
    requests: [],
    server: createServer(),
    silent: false,
    sent: []
  }
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
        let buffer = ''
        reply.on('data', (chunk: Buffer) => {
          if (incoming.url === '/v2/status') {
            buffer += chunk.toString()
            let end: number
            while ((end = buffer.indexOf('\n\n')) >= 0) {
              const text = buffer.slice(0, end)
              buffer = buffer.slice(end + 2)
              if (text.startsWith('event: status\ndata: ')) {
                const frame = JSON.parse(text.slice('event: status\ndata: '.length)) as {
                  observedAt: number
                  sentAt: number
                }
                serve.sent.push({ observedAt: frame.observedAt, sentAt: frame.sentAt })
              }
            }
          }
          if (!serve.silent) outgoing.write(chunk)
        })
        reply.on('end', () => outgoing.end())
        reply.on('error', () => outgoing.destroy())
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

/** Rows of a shared project: each row names its project after the tool ("Codex · shared-demo"). */
const projectRows = (page: Page, label: string) =>
  page.locator('.row-meta', { hasText: new RegExp(` · ${label}$`) })
const showsProject = (page: Page, label: string) => projectRows(page, label).first().waitFor()

/** The All Sessions view, from the sidebar or, below 960 px, the menu button's sheet. */
async function openAllSessions(page: Page) {
  const menu = page.getByRole('button', { name: 'Show views' })
  if (await menu.isVisible()) await menu.click()
  await page.getByRole('button', { name: /^All Sessions/ }).click()
}
const statusRequests = () => serve.requests.filter((path) => path === '/v2/status').length

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
    serve.silent = false
    serve.sent.length = 0
    serve.requests.length = 0
  })

  afterAll(async () => {
    await new Promise<void>((done) => serve.server.close(() => done()))
  })

  it('the owner login and Mac address reach Live with only projected data', async () => {
    await startListener()
    const page = await openPage()
    await expect.poll(() => pill(page).textContent()).toBe('Live')
    await showsProject(page, 'shared-demo')
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
    await showsProject(page, 'shared-demo')
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
    await showsProject(page, 'shared-demo')
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
    await showsProject(page, 'shared-demo')
    await stopListener('shutdown')
    // Reconnecting first, then lost after repeated Serve errors; the old data stays, dimmed.
    await expect.poll(() => pill(page).textContent()).toBe('Connection lost')
    expect(await page.locator('.pill').innerText()).toMatch(/showing data from/)
    expect(await page.locator('.status.dimmed').count()).toBe(1)
    await page.getByText('AgentPeek may be closed, or the Mac asleep or offline.').waitFor()
    await page.getByText(/Tailscale shows its own error page/).waitFor()

    await startListener([SHARED, LATER])
    await expect.poll(() => pill(page).textContent(), { timeout: 15_000 }).toBe('Live')
    await showsProject(page, 'later-demo')
    expect(await page.locator('.status.dimmed').count()).toBe(0)
    expect(await kept(page)).toEqual(NOTHING_KEPT)
  })

  it('keeps the sticky header above dimmed rows when a scrolled list loses its connection', async () => {
    await startListener([SHARED], sessions(Array<string>(40).fill(SHARED)))
    const page = await openPage({ width: 375, height: 500 })
    await showsProject(page, 'shared-demo')
    await page.mouse.wheel(0, 900)
    await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(300)
    await stopListener('shutdown')
    await expect.poll(() => pill(page).textContent()).toBe('Connection lost')
    // What is painted on top at points across the header must belong to the header, not a row.
    const covered = await page.evaluate(() => {
      const header = document.querySelector('header')!.getBoundingClientRect()
      const y = header.top + header.height / 2
      return [header.left + 4, header.left + header.width / 2, header.right - 4]
        .map((x) => document.elementFromPoint(x, y))
        .filter((hit) => !hit?.closest('header')).length
    })
    expect(covered).toBe(0)
    await page.screenshot({ path: join(repo, 'test-results/remote-lost-scrolled-375.png') })
  })

  it('Remote View turned off clears the list and reconnects when it is on again', async () => {
    await startListener()
    const page = await openPage()
    await showsProject(page, 'shared-demo')
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
    serve.silent = false
    serve.sent.length = 0
    serve.requests.length = 0
  })

  afterAll(async () => {
    await new Promise<void>((done) => serve.server.close(() => done()))
  })

  it('fits a 320-pixel viewport with no horizontal scroll and wrapped rows', async () => {
    await startListener([SHARED, LATER], mixed())
    const page = await openPage({ width: 320, height: 640 })
    await page.getByRole('heading', { level: 2, name: /^Waiting for you/ }).waitFor()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320)
    const row = page.locator('.row').first()
    const title = await row.locator('.row-title').boundingBox()
    const state = await row.locator('.row-state').boundingBox()
    expect(state!.y).toBeGreaterThan(title!.y + title!.height - 1)
    // Below 960 px the sidebar waits behind the menu button; every control keeps 44 px.
    expect(await page.locator('.sidebar').isVisible()).toBe(false)
    for (const control of await page.locator('.menu-button, .chip, .tool-filter button').all()) {
      expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    }
    const text = await page.locator('body').innerText()
    expect(text).toContain('Waiting for you · Permission')
    expect(text).toContain('2 need attention · 1 running · 0 unknown')
    expect(text).not.toContain(SENTINEL_TITLE)
    expect(text).not.toContain('SENTINEL-RAW-ID')
    await page.screenshot({ path: join(repo, 'test-results/remote-list-320.png'), fullPage: true })

    await page.getByRole('button', { name: 'Show views' }).click()
    await expect.poll(() => page.locator('.sidebar').isVisible()).toBe(true)
    expect(await page.locator('.sidebar').innerText()).toContain('All Sessions')
    await page.keyboard.press('Escape')
    await expect.poll(() => page.locator('.sidebar').isVisible()).toBe(false)
  })

  it('works from the keyboard and sends nothing but the status stream', async () => {
    await startListener([SHARED, LATER], mixed())
    const page = await openPage({ width: 1024, height: 768 })
    await page.getByRole('heading', { level: 2, name: /^Waiting for you/ }).waitFor()
    // Active: waiting, new reply and running; the idle session is not active.
    expect(await page.locator('.row').count()).toBe(3)
    expect(await page.locator('.sidebar').isVisible()).toBe(true)

    // Rows are not focusable: Tab goes Active, All Sessions, then the list's controls.
    await page.keyboard.press('Tab')
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('Active2')
    await page.keyboard.press('Tab')
    await page.keyboard.press('Enter')
    await expect.poll(() => page.locator('.row').count()).toBe(4)
    await page.keyboard.press('Tab')
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('Project')
    await page.keyboard.press('Enter')
    await showsProject(page, 'later-demo')
    expect(await page.getByRole('heading', { level: 2, name: /^shared-demo/ }).count()).toBe(1)
    expect(await page.getByRole('heading', { level: 2, name: /^later-demo/ }).count()).toBe(1)

    // Status, then the tool filter: All, Codex, Claude Code.
    await page.keyboard.press('Tab')
    await page.keyboard.press('Tab')
    await page.keyboard.press('Tab')
    await page.keyboard.press('Tab')
    expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe(
      'Claude Code, 2'
    )
    await page.keyboard.press('Enter')
    await expect.poll(() => page.locator('.row').count()).toBe(2)
    expect(await page.locator('.row').allInnerTexts()).toEqual(
      expect.arrayContaining([expect.stringContaining('Idle')])
    )
    await page.screenshot({ path: join(repo, 'test-results/remote-list-1024.png'), fullPage: true })

    expect(await page.evaluate(() => location.pathname + location.search + location.hash)).toBe('/')
    expect(await kept(page)).toEqual(NOTHING_KEPT)
    const paths = serve.requests.map((path) => (path.startsWith('/assets/') ? '/assets/' : path))
    expect([...new Set(paths)].sort()).toEqual(['/', '/assets/', '/v2/status'])
    expect(statusRequests()).toBe(1)
  })
})

describe('Remote View resilience budgets in a browser', () => {
  beforeAll(async () => {
    listenerPort = await freePort()
    serve = await startServe(() => listenerPort)
  })
  afterEach(async () => {
    for (const context of browser.contexts()) await context.close()
    await stopListener('shutdown')
    serve.silent = false
    serve.sent.length = 0
    serve.requests.length = 0
  })
  afterAll(async () => {
    await new Promise<void>((done) => serve.server.close(() => done()))
  })

  it('measures source-detection to DOM render with five streams of 250 rows', async () => {
    const load = (running: boolean) =>
      Array.from({ length: 250 }, (_, n) =>
        testSession({
          key: { tool: 'codex', id: `synthetic-load-${n}` },
          summary: {
            title: 'Synthetic load',
            workspacePath: SHARED,
            lastActivityAt: 1,
            toolVersion: '1'
          },
          activity: { state: running ? 'running' : 'idle' }
        })
      )
    await startListener([SHARED], load(false))
    const pages: Page[] = []
    // Sequential page entry stays inside the fixed request burst (four requests per page).
    for (let n = 0; n < 5; n += 1) {
      const page = await openPage()
      // All Sessions, so the rows stay listed while they turn idle.
      await openAllSessions(page)
      await expect.poll(() => page.locator('.row').count()).toBe(250)
      pages.push(page)
    }
    expect(listener!.streamCount()).toBe(5)
    const samples: { detectedAt: number; sentAt: number; renderedAt: number; ms: number }[] = []
    for (let step = 1; step <= 12; step += 1) {
      const running = step % 2 === 1
      const label = running ? 'Running' : 'Idle'
      // Observe actual React DOM changes and the next frame opportunity; do not write app state.
      await Promise.all(
        pages.map((page) =>
          page.evaluate((expected) => {
            const target = window as typeof window & { rendered?: Promise<number> }
            target.rendered = new Promise((resolve) => {
              const observer = new MutationObserver(() => {
                const rows = Array.from(document.querySelectorAll('.row-state'))
                if (rows.length !== 250 || !rows.every((row) => row.textContent === expected))
                  return
                observer.disconnect()
                requestAnimationFrame(() => resolve(performance.timeOrigin + performance.now()))
              })
              observer.observe(document.body, {
                subtree: true,
                childList: true,
                characterData: true
              })
            })
          }, label)
        )
      )
      // Synthetic source detection begins here, immediately before handing its snapshot over.
      const detectedAt = Date.now()
      listener!.publish({ ...snapshotOf([SHARED], load(running)), takenAt: detectedAt })
      const rendered = await Promise.all(
        pages.map((page) =>
          page.evaluate(() => (window as typeof window & { rendered: Promise<number> }).rendered)
        )
      )
      const sent = serve.sent.filter((frame) => frame.observedAt === detectedAt)
      expect(sent).toHaveLength(5)
      rendered.forEach((renderedAt, index) =>
        samples.push({
          detectedAt,
          sentAt: sent[index]!.sentAt,
          renderedAt,
          ms: renderedAt - detectedAt
        })
      )
    }
    const ordered = samples.map((sample) => sample.ms).sort((a, b) => a - b)
    const p95 = ordered[Math.ceil(ordered.length * 0.95) - 1]!
    const evidence = join(repo, 'test-results/remote-resilience')
    await mkdir(evidence, { recursive: true })
    await writeFile(
      join(evidence, 'load-budget.json'),
      JSON.stringify(
        {
          streams: 5,
          rows: 250,
          samples: samples.length,
          p95Ms: p95,
          maxMs: ordered.at(-1),
          targetMs: 2_000,
          scope:
            'Synthetic source detection -> real listener -> simulated Serve -> Chrome DOM commit plus next animation frame; not file write, real reader detection or physical display paint',
          measurements: samples
        },
        null,
        2
      )
    )
    expect(p95).toBeLessThanOrEqual(2_000)
  })

  it('shows connection lost after actual 45 s frame silence, then resyncs', async () => {
    const list = Array.from({ length: 250 }, (_, n) =>
      testSession({
        key: { tool: 'codex', id: `synthetic-silence-${n}` },
        summary: {
          title: 'Synthetic silence',
          workspacePath: SHARED,
          lastActivityAt: 1,
          toolVersion: '1'
        }
      })
    )
    await startListener([SHARED], list)
    const pages: { page: Page; liveAt: number }[] = []
    for (let n = 0; n < 5; n += 1) {
      const page = await openPage()
      await openAllSessions(page)
      await expect.poll(() => page.locator('.row').count()).toBe(250)
      pages.push({ page, liveAt: Date.now() })
    }
    expect(listener!.streamCount()).toBe(5)
    const page = pages[0]!.page
    serve.silent = true
    const elapsed = await Promise.all(
      pages.map(async ({ page, liveAt }) => {
        await expect
          .poll(() => pill(page).textContent(), { timeout: 48_000 })
          .toBe('Connection lost')
        const ms = Date.now() - liveAt
        expect(ms).toBeGreaterThanOrEqual(44_000)
        expect(ms).toBeLessThan(48_000)
        expect(await page.locator('.status.dimmed').count()).toBe(1)
        return ms
      })
    )
    const evidence = join(repo, 'test-results/remote-resilience')
    await mkdir(evidence, { recursive: true })
    await page.screenshot({ path: join(evidence, 'silence-lost.png'), fullPage: true })
    await writeFile(
      join(evidence, 'silence-budget.json'),
      JSON.stringify(
        {
          streams: 5,
          rowsPerStream: 250,
          targetMs: 45_000,
          observedMs: elapsed,
          scope: 'real timers, proxy withholds complete frames'
        },
        null,
        2
      )
    )
    serve.silent = false
    await stopListener('shutdown')
    await startListener([LATER])
    await Promise.all(
      pages.map(({ page }) =>
        expect.poll(() => pill(page).textContent(), { timeout: 10_000 }).toBe('Live')
      )
    )
    await showsProject(page, 'later-demo')
    expect(await projectRows(page, 'shared-demo').count()).toBe(0)
    await page.screenshot({ path: join(evidence, 'silence-recovered.png'), fullPage: true })
  }, 65_000)

  it('discards the old stream on page freeze and requests a full snapshot on resume', async () => {
    await startListener()
    const page = await openPage()
    await expect.poll(() => pill(page).textContent()).toBe('Live')
    // Chromium lifecycle events exercise the page wiring; physical phone suspension is TASK-027.
    await page.evaluate(() => document.dispatchEvent(new Event('freeze')))
    await expect.poll(() => pill(page).textContent()).toBe('Reconnecting')
    await expect.poll(() => listener!.streamCount()).toBe(0)
    await page.evaluate(() => document.dispatchEvent(new Event('resume')))
    await expect.poll(() => pill(page).textContent()).toBe('Live')
    expect(statusRequests()).toBe(2)
  })
})
