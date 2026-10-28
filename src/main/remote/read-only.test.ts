import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { testService, testSession } from '../test-support'
import { freePort, HOST, OWNER, send, subscribe } from './http-test-support'
import { createRemoteView, type RemoteView } from './remote-view'
import { REMOTE_SETTINGS_FILE } from './settings'

// TASK-015: browsing remotely is read-only. It never reaches the session controller, the sessions
// service's actions, system actions or a file named by a request. Synthetic data only.

// Every file function is watched, so a request that reads or writes anything on disk shows up.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  const watched = Object.fromEntries(
    Object.entries(actual).map(([name, value]) => [
      name,
      typeof value === 'function' ? vi.fn(value as (...args: unknown[]) => unknown) : value
    ])
  )
  return { ...watched, default: watched }
})

const SRC = resolve(__dirname, '../..')
const ALLOWED_BUILTINS = new Set([
  'node:crypto',
  'node:fs/promises',
  'node:http',
  'node:net',
  'node:path'
])

/** Every module the Remote View can reach, following relative imports from `remote-view.ts`. */
async function moduleGraph(entry: string) {
  const files = new Set<string>()
  const external = new Set<string>()
  const pending = [entry]
  while (pending.length > 0) {
    const file = pending.pop()!
    if (files.has(file)) continue
    files.add(file)
    const text = await fs.readFile(file, 'utf8')
    for (const [, specifier] of text.matchAll(/(?:from|import)\s+'([^']+)'/g)) {
      if (!specifier!.startsWith('.')) external.add(specifier!)
      else pending.push(`${resolve(dirname(file), specifier!)}.ts`)
    }
  }
  return { files: [...files].map((file) => relative(SRC, file)), external }
}

const SHARED = '/Users/synthetic/projects/shared-demo'
const folders: string[] = []
const views: RemoteView[] = []
afterEach(async () => {
  await Promise.all(views.splice(0).map((view) => view.close()))
  for (const folder of folders.splice(0)) await fs.rm(folder, { recursive: true, force: true })
})

describe('Remote View read-only boundary', () => {
  it('reaches only core modules and its own, never the controller, IPC, service or Electron', async () => {
    const { files, external } = await moduleGraph(join(SRC, 'main/remote/remote-view.ts'))
    for (const file of files) expect(file).toMatch(/^(core\/|main\/remote\/[^/]+\.ts$)/)
    expect(files).not.toContain('main/remote/preview/preview-server.ts')
    for (const specifier of external) expect(ALLOWED_BUILTINS).toContain(specifier)
  })

  it('answers requests without any service action or file access, whatever they name', async () => {
    const folder = await fs.mkdtemp(join(tmpdir(), 'agentpeek-remote-read-only-'))
    folders.push(folder)
    const viewer = join(folder, 'viewer')
    await fs.mkdir(join(viewer, 'assets'), { recursive: true })
    await fs.writeFile(join(viewer, 'index.html'), '<!doctype html><title>AgentPeek</title>')
    await fs.writeFile(join(viewer, 'assets', 'index-AbC123.js'), 'void 0')
    const port = await freePort()
    await fs.writeFile(
      join(folder, REMOTE_SETTINGS_FILE),
      JSON.stringify({
        version: 1,
        enabled: true,
        ownerLogin: OWNER,
        hostName: HOST,
        port,
        sharedWorkspaces: [SHARED],
        shareTitles: true
      })
    )
    const service = testService([
      testSession({ summary: { ...testSession().summary, workspacePath: SHARED } })
    ])
    const before = structuredClone(service.snapshot())
    // As `src/main/index.ts` wires it: the snapshot and nothing else.
    const view = createRemoteView({
      folder,
      viewerFolder: viewer,
      snapshot: () => service.snapshot()
    })
    views.push(view)
    await view.open()
    expect(view.status()).toMatchObject({ state: 'on' })
    vi.clearAllMocks()

    const stream = subscribe(port)
    await expect.poll(() => stream.frames.length).toBe(1)
    const replies = new Map<string, number>()
    for (const [method, path] of [
      ['GET', '/'],
      ['GET', '/assets/index-AbC123.js'],
      ['GET', '/assets/../index.html'],
      ['GET', '/assets/..%2F..%2Fsettings.json'],
      ['GET', `/assets/${REMOTE_SETTINGS_FILE}`],
      ['GET', `/v1/status?workspace=${SHARED}`],
      ['GET', `/${SHARED}`],
      ['GET', `/%2FUsers%2Fsynthetic`],
      ['GET', '//etc/hosts'],
      ['GET', '/v1/sessions/abc/messages'],
      ['GET', '/v1/skills/abc'],
      ['POST', '/v1/read'],
      ['PUT', '/v1/pin'],
      ['DELETE', '/v1/status']
    ] as const) {
      replies.set(`${method} ${path}`, (await send(port, { method, path })).status)
    }
    stream.disconnect()

    expect(replies.get('GET /')).toBe(200)
    expect(replies.get('GET /assets/index-AbC123.js')).toBe(200)
    for (const [request, status] of replies) {
      if (request === 'GET /' || request === 'GET /assets/index-AbC123.js') continue
      expect([400, 404, 405], request).toContain(status)
    }
    for (const [name, action] of Object.entries(service)) {
      if (name !== 'snapshot') expect(action, name).not.toHaveBeenCalled()
    }
    for (const [name, value] of Object.entries(fs)) {
      if (vi.isMockFunction(value)) expect(value, name).not.toHaveBeenCalled()
    }
    expect(service.snapshot()).toEqual(before)
  })
})
