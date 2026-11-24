import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshot } from '../../core/snapshot'
import { testSession } from '../test-support'
import {
  exchange,
  freePort,
  HOST,
  OWNER,
  OWNER_HEADERS,
  rawHead,
  send,
  subscribe,
  type Reply
} from './http-test-support'
import { startRemoteListener, type RemoteListener } from './listener'
import { createRemoteView, type RemoteView } from './remote-view'
import { REMOTE_SETTINGS_FILE, saveRemoteSettings } from './settings'

// Synthetic only. The configured login and workspace path may persist as settings; request
// identities, derived labels, titles and status payloads may not become a second data store.
const TITLE = 'SENTINEL-TITLE <img src=x onerror=alert(1)>'
const REQUEST_LOGIN = 'sentinel-request@example.com'
const RAW_ID = 'SENTINEL-RAW-ID'
const SHARED = '/Users/synthetic/projects/shared-demo'
const snapshot = createSnapshot({
  sessions: [
    testSession({
      key: { tool: 'codex', id: RAW_ID },
      summary: { title: TITLE, workspacePath: SHARED, lastActivityAt: 1, toolVersion: '1' }
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
})
const listeners: RemoteListener[] = []
const views: RemoteView[] = []
const folders: string[] = []

async function start(now?: () => number) {
  let clock = 0
  const result = await startRemoteListener({
    port: await freePort(),
    access: { ownerLogin: OWNER, hostName: HOST },
    secret: new Uint8Array(32).fill(7),
    viewer: {
      page: Buffer.from('<!doctype html><title>AgentPeek</title>'),
      assets: new Map([
        ['/assets/index-AbC12345.js', { body: Buffer.from('void 0'), type: 'text/javascript' }],
        ['/assets/index-AbC12345.css', { body: Buffer.from('body{}'), type: 'text/css' }]
      ])
    },
    snapshot: () => snapshot,
    sharing: () => ({ sharedWorkspaces: [SHARED], shareTitles: true }),
    generation: () => 0,
    now: now ?? (() => (clock += 100))
  })
  if (!result.ok) throw new Error(result.error)
  listeners.push(result.listener)
  return result.listener
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(listeners.splice(0).map((listener) => listener.close('shutdown')))
  await Promise.all(views.splice(0).map((view) => view.close()))
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })))
})

function hardened(reply: Pick<Reply, 'headers'>, cache = 'no-store') {
  expect(reply.headers['cache-control']).toBe(cache)
  expect(reply.headers['x-content-type-options']).toBe('nosniff')
  expect(reply.headers['referrer-policy']).toBe('no-referrer')
  expect(reply.headers['cross-origin-resource-policy']).toBe('same-origin')
  expect(reply.headers['content-security-policy']).toContain("frame-ancestors 'none'")
  expect(reply.headers.server).toBeUndefined()
  expect(reply.headers['x-powered-by']).toBeUndefined()
  expect(reply.headers['set-cookie']).toBeUndefined()
  expect(Object.keys(reply.headers).some((key) => key.startsWith('access-control-'))).toBe(false)
}

function noPrivateText(value: string) {
  for (const sentinel of [TITLE, REQUEST_LOGIN, RAW_ID, SHARED, OWNER, HOST]) {
    expect(value).not.toContain(sentinel)
  }
}

describe('Remote View response privacy', () => {
  it('hardens the page, both asset types, stream and every refusal path', async () => {
    const listener = await start()
    const page = await send(listener.port)
    hardened(page)
    for (const directive of [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
      "connect-src 'self'",
      "worker-src 'none'",
      "child-src 'none'",
      "base-uri 'none'",
      "form-action 'none'"
    ]) {
      expect(page.headers['content-security-policy']).toContain(directive)
    }
    noPrivateText(page.body)
    for (const extension of ['js', 'css']) {
      const asset = await send(listener.port, { path: `/assets/index-AbC12345.${extension}` })
      expect(asset.status).toBe(200)
      hardened(asset, 'public, max-age=31536000, immutable')
      noPrivateText(asset.body)
    }
    const streams = Array.from({ length: 5 }, () => subscribe(listener.port))
    await expect.poll(() => streams.every((stream) => stream.frames.length === 1)).toBe(true)
    hardened({ headers: streams[0]!.response()!.headers })
    expect(streams[0]!.raw.join('')).toContain(TITLE)

    const cases = [
      { headers: { Host: HOST, 'Tailscale-User-Login': REQUEST_LOGIN }, status: 403 },
      { headers: { ...OWNER_HEADERS, Host: 'sentinel-host.invalid' }, status: 421 },
      { headers: { ...OWNER_HEADERS, Origin: 'https://sentinel-origin.invalid' }, status: 403 },
      { method: 'POST', status: 405 },
      { headers: { ...OWNER_HEADERS, 'Content-Length': '1' }, status: 400 },
      { path: '/v3/status', status: 404 },
      { path: '/sentinel-target', status: 404 },
      { path: '/assets/missing-AbC12345.js', status: 404 },
      { path: '/v2/status', status: 503 }
    ]
    for (const options of cases) {
      const reply = await send(listener.port, options)
      expect(reply.status).toBe(options.status)
      hardened(reply)
      expect(reply.headers['content-security-policy']).toContain("default-src 'none'")
      noPrivateText(JSON.stringify(reply))
    }
    const raw = await exchange(
      listener.port,
      rawHead(['GET / HTTP/1.1', `Host: ${HOST}`, `X-Sentinel: ${TITLE}`, 'Invalid Header'])
    )
    expect(raw.reply).toContain('400 Bad Request')
    for (const header of [
      'Cache-Control: no-store',
      'X-Content-Type-Options: nosniff',
      'Referrer-Policy: no-referrer',
      "frame-ancestors 'none'"
    ])
      expect(raw.reply).toContain(header)
    expect(raw.reply).not.toMatch(/Server:|X-Powered-By:|HPE_|ERR_/i)
    noPrivateText(raw.reply)
  })

  it('hardens rate-limit replies without echoing the request identity or target', async () => {
    const { port } = await start(() => 0)
    for (let i = 0; i < 20; i++) await send(port)
    for (const path of ['/', `/sentinel-target-${RAW_ID}`]) {
      const reply = await send(port, {
        path,
        headers: { Host: HOST, 'Tailscale-User-Login': REQUEST_LOGIN }
      })
      expect(reply.status).toBe(429)
      hardened(reply)
      noPrivateText(JSON.stringify(reply))
    }
  })

  it('logs no request/payload/error text and persists only the approved settings', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'agentpeek-privacy-'))
    folders.push(folder)
    const port = await freePort()
    const settings = {
      enabled: true,
      ownerLogin: OWNER,
      hostName: HOST,
      port,
      sharedWorkspaces: [SHARED],
      shareTitles: true
    }
    await saveRemoteSettings(folder, settings)
    const output: string[] = []
    for (const method of ['log', 'info', 'debug', 'warn', 'error'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        output.push(args.map(String).join(' '))
      })
    }
    const view = createRemoteView({ folder, viewerFolder: folder, snapshot: () => snapshot })
    views.push(view)
    await view.open()
    const stream = subscribe(port)
    await expect.poll(() => stream.frames.length).toBe(1)
    expect(stream.raw.join('')).toContain(TITLE)
    const denied = await send(port, {
      path: `/sentinel-target-${RAW_ID}`,
      headers: { Host: HOST, 'Tailscale-User-Login': REQUEST_LOGIN }
    })
    expect(denied.status).toBe(403)
    noPrivateText(JSON.stringify(denied))
    expect(await view.setShareTitles(false)).toEqual({ ok: true })
    await view.close()
    expect(await readdir(folder)).toEqual([REMOTE_SETTINGS_FILE])
    expect(JSON.parse(await readFile(join(folder, REMOTE_SETTINGS_FILE), 'utf8'))).toEqual({
      version: 1,
      ...settings,
      shareTitles: false
    })
    // An I/O exception can contain private paths; the only returned error is fixed copy.
    const blocked = join(folder, REQUEST_LOGIN)
    await writeFile(blocked, '')
    await expect(saveRemoteSettings(blocked, settings)).rejects.toThrow(
      /^Could not save Remote View settings\.$/
    )
    expect(output).toEqual([])
  })
})
