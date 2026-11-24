/// <reference lib="dom" />
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { createServer, request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type BrowserContext } from '@playwright/test'
import { afterEach, describe, expect, it } from 'vitest'
import type { RecentMessages } from '../../../src/core/session'
import { createSnapshot } from '../../../src/core/snapshot'
import { freePort, HOST, OWNER } from '../../../src/main/remote/http-test-support'
import { startRemoteListener, type RemoteListener } from '../../../src/main/remote/listener'
import { loadViewerFiles } from '../../../src/main/remote/viewer-files'
import { testSession } from '../../../src/main/test-support'

// Built production page + real listener + synthetic loopback Serve, no windows or real accounts.
// A persistent scratch browser profile lets us inspect HTTP cache files after Chromium exits.
const repo = join(import.meta.dirname, '../../..')
const LABEL = 'SENTINEL-LABEL <svg onload=alert(1)>'
const TITLE = 'SENTINEL-TITLE <img src=x onerror=alert(1)>'
const REQUEST_LOGIN = 'sentinel-request@example.com'
const BUILD_SENTINEL = 'SENTINEL-BUILD-NOT-USED'
const workspace = `/Users/synthetic/projects/${LABEL}`
let listener: RemoteListener | undefined
let proxy: Server | undefined
let context: BrowserContext | undefined
let scratch: string | undefined

async function filesBelow(folder: string): Promise<string[]> {
  const entries = await readdir(folder, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(folder, entry.name)
      return entry.isDirectory() ? filesBelow(path) : entry.isFile() ? [path] : []
    })
  )
  return files.flat()
}

async function setup(probe = false, messages?: RecentMessages) {
  const viewer = await loadViewerFiles(join(repo, 'out/remote-web'))
  if (!viewer.page || viewer.assets.size === 0) throw new Error('Build the viewer first.')
  const assets = new Map(viewer.assets)
  if (probe)
    assets.set('/assets/probe-AbC12345.js', {
      type: 'text/javascript',
      // Loaded as a real script: DevTools evaluation itself bypasses CSP's eval restriction.
      body: Buffer.from("try { new Function('return 1')() } catch { window.evalBlocked = true }")
    })
  const result = await startRemoteListener({
    port: await freePort(),
    access: { ownerLogin: OWNER, hostName: HOST },
    secret: new Uint8Array(32).fill(7),
    viewer: { ...viewer, assets },
    snapshot: () =>
      createSnapshot({
        sessions: [
          testSession({
            key: { tool: 'codex', id: 'SENTINEL-RAW-ID' },
            summary: {
              title: TITLE,
              workspacePath: workspace,
              lastActivityAt: 1,
              toolVersion: '1'
            },
            // Running, so the default Active view lists it.
            activity: { state: 'running' }
          })
        ],
        health: {
          codex: { state: 'connected', lastReadAt: 1 },
          claude: { state: 'not-installed' },
          antigravity: { state: 'not-installed' }
        },
        localState: { kind: 'available' },
        firstLaunch: false,
        fixture: true,
        takenAt: 1
      }),
    sharing: () => ({
      sharedWorkspaces: [workspace, '/Users/synthetic/projects/other-demo'],
      shareTitles: true
    }),
    generation: () => 0,
    ...(messages
      ? { details: () => true, readMessages: () => Promise.resolve(structuredClone(messages)) }
      : {})
  })
  if (!result.ok) throw new Error(result.error)
  listener = result.listener
  const port = listener.port
  const identity = { login: OWNER }
  proxy = createServer((incoming, outgoing) => {
    const upstream = request(
      {
        host: '127.0.0.1',
        port,
        path: incoming.url,
        method: incoming.method,
        headers: {
          Host: HOST,
          'Tailscale-User-Login': identity.login,
          ...(incoming.headers.origin ? { Origin: `https://${HOST}` } : {})
        }
      },
      (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers)
        response.pipe(outgoing)
      }
    )
    upstream.on('error', () => outgoing.destroy())
    outgoing.on('close', () => upstream.destroy())
    incoming.pipe(upstream)
  })
  await new Promise<void>((done) => proxy!.listen({ host: '127.0.0.1', port: 0 }, done))
  const origin = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`
  scratch = await mkdtemp(join(tmpdir(), 'agentpeek-web-privacy-'))
  const profile = join(scratch, 'profile')
  context = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: true })
  return { origin, profile, identity, context, viewer }
}

afterEach(async () => {
  await context?.close()
  context = undefined
  await listener?.close('shutdown')
  listener = undefined
  await new Promise<void>((done) => (proxy ? proxy.close(() => done()) : done()))
  proxy = undefined
  if (scratch) await rm(scratch, { recursive: true, force: true })
  scratch = undefined
})

describe('Remote View privacy in the production browser page', () => {
  it('renders untrusted labels/titles as text and leaves no payload in storage or HTTP caches', async () => {
    const { origin, profile, identity, context } = await setup()
    const page = context.pages()[0]!
    const requests: string[] = []
    const output: string[] = []
    context.on('request', (req) => requests.push(req.url()))
    page.on('console', (message) => output.push(message.text()))
    page.on('pageerror', (error) => output.push(error.message))
    await page.goto(origin)
    await expect.poll(() => page.getByRole('status').textContent()).toBe('Live')
    expect(await page.locator('.row-title').textContent()).toBe(TITLE)
    expect(await page.locator('img, svg, iframe, object, embed').count()).toBe(0)
    // Grouped by project through its real control, the label is a heading, as literal text.
    await page.getByRole('button', { name: 'Project', exact: true }).click()
    expect(await page.locator('.group-heading > span:first-child').allTextContents()).toContain(
      LABEL
    )
    expect(await page.locator('img, svg, iframe, object, embed').count()).toBe(0)
    const kept = await page.evaluate(async () => ({
      local: localStorage.length,
      session: sessionStorage.length,
      cookies: document.cookie,
      databases: (await indexedDB.databases()).length,
      caches: (await caches.keys()).length,
      workers: (await navigator.serviceWorker.getRegistrations()).length,
      path: location.pathname + location.search + location.hash
    }))
    expect(kept).toEqual({
      local: 0,
      session: 0,
      cookies: '',
      databases: 0,
      caches: 0,
      workers: 0,
      path: '/'
    })
    expect(requests.every((url) => new URL(url).origin === origin)).toBe(true)
    expect(requests.filter((url) => new URL(url).pathname === '/v2/status')).toHaveLength(1)
    expect(
      requests.every((url) => {
        const path = new URL(url).pathname
        return path === '/' || path === '/v2/status' || /^\/assets\/[\w-]+\.(js|css)$/.test(path)
      })
    ).toBe(true)

    // The allowed document/status must not become an offline copy.
    await page.goto('about:blank')
    await context.setOffline(true)
    await expect(page.goto(origin, { timeout: 5_000 })).rejects.toThrow()
    await context.setOffline(false)

    // Revisit with a refused identity: cached content must not bypass the new access check.
    identity.login = REQUEST_LOGIN
    const denied = await page.goto(origin)
    expect(denied?.status()).toBe(403)
    const deniedBody = await page.locator('body').innerText()
    for (const sentinel of [TITLE, LABEL, REQUEST_LOGIN, OWNER, HOST]) {
      expect(deniedBody).not.toContain(sentinel)
      expect(output.join('\n')).not.toContain(sentinel)
    }
    await context.close()
    // Closing the context flushes the real disk profile, including Chromium's HTTP caches.
    for (const file of await filesBelow(profile)) {
      const bytes = await readFile(file)
      for (const sentinel of [TITLE, LABEL, REQUEST_LOGIN, OWNER, HOST]) {
        expect(
          bytes.includes(Buffer.from(sentinel)),
          `private UTF-8 text on disk: ${file.slice(profile.length)} / ${[TITLE, LABEL, REQUEST_LOGIN, OWNER, HOST].indexOf(sentinel)}`
        ).toBe(false)
        expect(
          bytes.includes(Buffer.from(sentinel, 'utf16le')),
          `private UTF-16 text on disk: ${file.slice(profile.length)} / ${[TITLE, LABEL, REQUEST_LOGIN, OWNER, HOST].indexOf(sentinel)}`
        ).toBe(false)
      }
    }
  })

  it('blocks third-party loads, inline execution, workers and service workers', async () => {
    const { origin, context, viewer } = await setup(true)
    const page = context.pages()[0]!
    const foreign: string[] = []
    // Defense for this adversarial test: even a regressed CSP cannot make an external request.
    await context.route('**/*', (route) => {
      if (new URL(route.request().url()).origin !== origin) {
        foreign.push(route.request().url())
        return route.abort()
      }
      return route.continue()
    })
    await page.addInitScript(() => {
      const state = window as typeof window & { violations: string[]; inlineRan?: boolean }
      state.violations = []
      document.addEventListener('securitypolicyviolation', (event) => {
        state.violations.push(event.effectiveDirective)
      })
    })
    await page.goto(origin)
    await expect.poll(() => page.getByRole('status').textContent()).toBe('Live')
    const scriptPath = [...viewer.assets.keys()].find((path) => path.endsWith('.js'))!
    const blocked = await page.evaluate(async (asset) => {
      const script = document.createElement('script')
      script.src = 'https://third-party.invalid/probe.js'
      document.head.append(script)
      const inline = document.createElement('script')
      inline.textContent = 'window.inlineRan = true'
      document.head.append(inline)
      const style = document.createElement('link')
      style.rel = 'stylesheet'
      style.href = 'https://third-party.invalid/probe.css'
      document.head.append(style)
      const image = new Image()
      image.src = 'https://third-party.invalid/probe.png'
      document.body.append(image)
      const connect = await fetch('https://third-party.invalid/probe').then(
        () => false,
        () => true
      )
      const font = await new FontFace('probe', 'url(https://third-party.invalid/probe.woff2)')
        .load()
        .then(
          () => false,
          () => true
        )
      await new Promise<void>((done, fail) => {
        const probe = document.createElement('script')
        probe.src = '/assets/probe-AbC12345.js'
        probe.onload = () => done()
        probe.onerror = () => fail(new Error('CSP probe did not load'))
        document.head.append(probe)
      })
      const evalBlocked = (window as typeof window & { evalBlocked?: boolean }).evalBlocked === true
      const worker = await new Promise<boolean>((done) => {
        try {
          const worker = new Worker(asset, { type: 'module' })
          worker.onerror = (event) => {
            event.preventDefault()
            worker.terminate()
            done(true)
          }
          worker.onmessage = () => {
            worker.terminate()
            done(false)
          }
        } catch {
          done(true)
        }
      })
      const serviceWorker = await navigator.serviceWorker.register(asset, { type: 'module' }).then(
        () => false,
        () => true
      )
      return { connect, font, evalBlocked, worker, serviceWorker }
    }, scriptPath)
    expect(blocked).toEqual({
      connect: true,
      font: true,
      evalBlocked: true,
      worker: true,
      serviceWorker: true
    })
    await expect
      .poll(() =>
        page.evaluate(() => {
          const state = window as typeof window & { violations: string[] }
          return [...new Set(state.violations)].sort()
        })
      )
      .toEqual([
        'connect-src',
        'font-src',
        'img-src',
        'script-src',
        'script-src-elem',
        'style-src-elem',
        'worker-src'
      ])
    expect(
      await page.evaluate(() => (window as typeof window & { inlineRan?: boolean }).inlineRan)
    ).toBeUndefined()
    expect(foreign).toEqual([])
    expect(
      await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)
    ).toBe(0)
  })

  it('shows hostile recent messages inertly: no script, no load, nothing kept after Back', async () => {
    const MESSAGE = 'SENTINEL-MESSAGE'
    const hostile = [
      `${MESSAGE} **bold**`,
      '<script>window.pwned = 1</script>',
      '<img src="https://third-party.invalid/a.png" onerror="window.pwned = 2">',
      '<iframe src="https://third-party.invalid/"></iframe>',
      '<style>body { display: none }</style>',
      '[link](https://third-party.invalid/l) [js](javascript:window.pwned=3)',
      '![pixel](https://third-party.invalid/p.gif) ![local](/v2/status)',
      '<https://third-party.invalid/auto>',
      '<svg onload="window.pwned = 4"></svg>'
    ].join('\n\n')
    const { origin, profile, context } = await setup(false, {
      kind: 'messages',
      messages: [
        { kind: 'prompt', text: `${MESSAGE} prompt`, at: 1 },
        { kind: 'reply', text: hostile, at: 2 }
      ],
      hasOlder: false
    })
    const page = context.pages()[0]!
    const requests: string[] = []
    const foreign: string[] = []
    const output: string[] = []
    await context.route('**/*', (route) => {
      requests.push(route.request().url())
      if (new URL(route.request().url()).origin !== origin) {
        foreign.push(route.request().url())
        return route.abort()
      }
      return route.continue()
    })
    page.on('console', (message) => output.push(message.text()))
    page.on('pageerror', (error) => output.push(error.message))
    await page.addInitScript(() => {
      const state = window as typeof window & { violations: string[] }
      state.violations = []
      document.addEventListener('securitypolicyviolation', (event) => {
        state.violations.push(event.effectiveDirective)
      })
    })
    await page.goto(origin)
    await expect.poll(() => page.getByRole('status').textContent()).toBe('Live')
    await page.getByRole('button', { name: new RegExp(TITLE.slice(0, 14)) }).click()
    const detail = page.getByTestId('detail')
    await expect.poll(() => detail.textContent()).toContain(`${MESSAGE} bold`)
    expect(await detail.textContent()).toContain('<script>window.pwned = 1</script>')
    expect(await detail.locator('a, img, script, iframe, style, svg, object, embed').count()).toBe(
      0
    )
    expect(await page.evaluate(() => (window as { pwned?: number }).pwned)).toBeUndefined()
    // Nothing tried to load: no request beyond the page, its assets, the status and one read.
    expect(foreign).toEqual([])
    expect(
      await page.evaluate(() => (window as unknown as { violations: string[] }).violations)
    ).toEqual([])
    expect(
      requests.every((url) => {
        const path = new URL(url).pathname
        return (
          path === '/' ||
          path === '/v2/status' ||
          /^\/v2\/sessions\/[\w-]{22}\/messages$/.test(path) ||
          /^\/assets\/[\w-]+\.(js|css)$/.test(path)
        )
      })
    ).toBe(true)
    expect(requests.filter((url) => url.endsWith('/messages'))).toHaveLength(1)

    // Layout: under 960 px the detail replaces the list with no horizontal scroll; from 960 px
    // the list stays beside it.
    const layout = () =>
      page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        listShown: getComputedStyle(document.querySelector('.split-list')!).display !== 'none'
      }))
    await page.setViewportSize({ width: 320, height: 640 })
    expect(await layout()).toEqual({ overflow: false, listShown: false })
    await page.screenshot({ path: join(repo, 'test-results/remote-detail-320.png') })
    await page.setViewportSize({ width: 1024, height: 768 })
    expect(await layout()).toEqual({ overflow: false, listShown: true })
    await page.screenshot({ path: join(repo, 'test-results/remote-detail-1024.png') })

    // Back returns to the list (the phone gesture), and the text leaves the page.
    await page.goBack()
    await expect.poll(() => detail.count()).toBe(0)
    expect(await page.locator('body').innerText()).not.toContain(MESSAGE)
    expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe('/')
    const kept = await page.evaluate(() => ({
      local: localStorage.length,
      session: sessionStorage.length,
      history: JSON.stringify(history.state)
    }))
    expect(kept).toEqual({ local: 0, session: 0, history: 'null' })
    expect(output.join('\n')).not.toContain(MESSAGE)
    await context.close()
    for (const file of await filesBelow(profile)) {
      const bytes = await readFile(file)
      expect(bytes.includes(Buffer.from(MESSAGE)), `message text on disk: ${file}`).toBe(false)
      expect(bytes.includes(Buffer.from(MESSAGE, 'utf16le')), `message text on disk: ${file}`).toBe(
        false
      )
    }
  })

  it('ships only the static production page and hashed assets without debug transport or build inputs', async () => {
    const folder = join(repo, 'out/remote-web')
    const files = await filesBelow(folder)
    expect(files.length).toBeGreaterThan(1)
    for (const file of files) {
      const relative = file.slice(folder.length + 1)
      expect(relative).toMatch(/^(index\.html|assets\/[\w-]+-[\w-]{8}\.(js|css))$/)
      const text = await readFile(file, 'utf8')
      expect(text).not.toMatch(
        /sourceMappingURL|\/@vite\/client|@react-refresh|window\.agentpeek|node:inspector|new WebSocket/
      )
      for (const value of [BUILD_SENTINEL, TITLE, LABEL, REQUEST_LOGIN, OWNER, HOST]) {
        expect(text).not.toContain(value)
      }
    }
  })
})
