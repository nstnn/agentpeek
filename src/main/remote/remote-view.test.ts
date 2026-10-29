import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { REMOTE_LIMITS, type RemoteFrame, type StatusFrame } from '../../core/remote/protocol'
import type { Session } from '../../core/session'
import type { RemoteListener, RemoteListenerStart } from './listener'
import { createSnapshot, type SessionsSnapshot } from '../../core/snapshot'
import { testSession } from '../test-support'
import { accepts, freePort, HOST, OWNER, OWNER_HEADERS, send, subscribe } from './http-test-support'
import { createRemoteView, type RemoteView, type RemoteViewOptions } from './remote-view'
import { REMOTE_SETTINGS_FILE } from './settings'
import * as settingsStore from './settings'

// Synthetic data only: a temporary state folder, simulated Serve headers, no window.
const SHARED = '/Users/synthetic/projects/shared-demo'
const snapshot = createSnapshot({
  sessions: [testSession({ summary: { ...testSession().summary, workspacePath: SHARED } })],
  health: { codex: { state: 'connected', lastReadAt: 1 }, claude: { state: 'not-installed' } },
  localState: { kind: 'available' },
  firstLaunch: false,
  fixture: true,
  takenAt: 1
})

const folders: string[] = []
const views: RemoteView[] = []
async function setup(
  saved?: object,
  current: () => SessionsSnapshot = () => snapshot,
  onChange?: RemoteViewOptions['onChange']
) {
  const folder = await mkdtemp(join(tmpdir(), 'agentpeek-remote-view-'))
  folders.push(folder)
  const port = await freePort()
  if (saved) {
    await writeFile(
      join(folder, REMOTE_SETTINGS_FILE),
      JSON.stringify({
        version: 1,
        ownerLogin: OWNER,
        hostName: HOST,
        port,
        sharedWorkspaces: [SHARED],
        ...saved
      })
    )
  }
  const view = createRemoteView({
    folder,
    viewerFolder: join(folder, 'no-viewer-build'),
    snapshot: current,
    onChange
  })
  views.push(view)
  await view.open()
  return { folder, port, view }
}
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(views.splice(0).map((view) => view.close()))
  for (const folder of folders.splice(0)) {
    await chmod(folder, 0o700)
    await rm(folder, { recursive: true, force: true })
  }
})

const servers = () => process.getActiveResourcesInfo().filter((name) => name === 'TCPServerWrap')
const savedFile = async (folder: string) =>
  JSON.parse(await readFile(join(folder, REMOTE_SETTINGS_FILE), 'utf8')) as Record<string, unknown>
const connection = (port: number) => ({ ownerLogin: OWNER, hostName: HOST, port })

describe('Remote View off', () => {
  it('opens no socket on a fresh install and cannot turn on before it is configured', async () => {
    const before = servers().length
    const { folder, view } = await setup()
    expect(view.status()).toEqual({
      state: 'off',
      settings: {
        enabled: false,
        ownerLogin: '',
        hostName: '',
        port: 47613,
        sharedWorkspaces: [],
        shareTitles: false
      },
      startError: null
    })
    expect(await view.enable()).toEqual({ ok: false, error: 'not-configured' })
    expect(servers().length).toBe(before)
    await expect(readFile(join(folder, REMOTE_SETTINGS_FILE))).rejects.toThrow()
  })

  it('stays off when the saved settings cannot be read', async () => {
    const before = servers().length
    const { port, view } = await setup({ enabled: true, port: 80 })
    expect(view.status()).toEqual({ state: 'load-failed' })
    expect(await view.enable()).toEqual({ ok: false, error: 'not-loaded' })
    expect(await view.saveConnection(connection(port))).toEqual({ ok: false, error: 'not-loaded' })
    expect(servers().length).toBe(before)
  })

  it('reads the file again on Try Again, and resumes as at launch once it loads', async () => {
    const { folder, port, view } = await setup({ enabled: true, port: 80 })
    await view.retryLoad()
    expect(view.status()).toEqual({ state: 'load-failed' })
    const fixed = { version: 1, enabled: true, ...connection(port), sharedWorkspaces: [] }
    await writeFile(join(folder, REMOTE_SETTINGS_FILE), JSON.stringify(fixed))
    await view.retryLoad()
    expect(view.status()).toMatchObject({ state: 'on', resumed: true })
    // Loaded settings are never read again: the file is not the source of truth any more.
    await writeFile(
      join(folder, REMOTE_SETTINGS_FILE),
      JSON.stringify({ ...fixed, enabled: false, port: port === 65535 ? 1024 : port + 1 })
    )
    await view.retryLoad()
    expect(view.status()).toMatchObject({ state: 'on', settings: { port } })
  })
})

describe('Remote View on', () => {
  it('saves "on" before listening, then serves the owner on the configured port', async () => {
    const { folder, port, view } = await setup()
    expect(
      await view.saveConnection({ ownerLogin: ' owner@example.com', hostName: HOST, port })
    ).toEqual({ ok: true })
    expect(await accepts(port)).toBe(false)
    expect(await view.enable()).toEqual({ ok: true })
    expect(await savedFile(folder)).toMatchObject({ enabled: true, ...connection(port) })
    expect(view.status()).toMatchObject({ state: 'on', resumed: false, streams: 0 })
    expect((await send(port, { path: '/missing' })).status).toBe(404)
    expect((await send(port, { headers: { Host: HOST } })).status).toBe(403)
  })

  it('does not listen when saving "on" fails', async () => {
    const { folder, port, view } = await setup({ enabled: false })
    await chmod(folder, 0o500)
    expect(await view.enable()).toEqual({ ok: false, error: 'save-failed' })
    expect(await accepts(port)).toBe(false)
    expect(view.status()).toMatchObject({ state: 'off', settings: { enabled: false } })
  })

  it('turns on again at launch when it was on at quit', async () => {
    const { port, view } = await setup({ enabled: true })
    expect(view.status()).toMatchObject({ state: 'on', resumed: true })
    expect((await send(port)).status).toBe(404)
  })

  it('reports a port in use, stays off and saves "off" instead of trying another port', async () => {
    const port = await freePort()
    const other = createServer()
    await new Promise<void>((done) => other.listen({ host: '127.0.0.1', port }, done))
    try {
      const { folder, view } = await setup({ enabled: false })
      await view.saveConnection(connection(port))
      expect(await view.enable()).toEqual({ ok: false, error: 'port-in-use' })
      expect(view.status()).toMatchObject({ state: 'off', startError: 'port-in-use' })
      // Saving the same values keeps the error; a new port clears it until the next start.
      await view.saveConnection(connection(port))
      expect(view.status()).toMatchObject({ startError: 'port-in-use' })
      await view.saveConnection(connection(port === 65535 ? 1024 : port + 1))
      expect(view.status()).toMatchObject({ state: 'off', startError: null })
      await view.close()
      expect(await savedFile(folder)).toMatchObject({ enabled: false })
    } finally {
      await new Promise<void>((done) => other.close(() => done()))
    }
  })
})

describe('Remote View turning off and access changes', () => {
  it('ends streams with remote-off and closes the listener, then saves "off"', async () => {
    const { folder, port, view } = await setup({ enabled: true })
    const viewer = subscribe(port)
    await expect.poll(() => viewer.frames.length).toBe(1)
    expect(view.status()).toMatchObject({ state: 'on', streams: 1 })
    expect(await view.disable()).toEqual({ ok: true })
    await viewer.ended
    expect(viewer.frames.at(-1)).toEqual({ v: 1, type: 'end', reason: 'remote-off' })
    expect(await accepts(port)).toBe(false)
    expect(await savedFile(folder)).toMatchObject({ enabled: false })
    expect(view.status()).toMatchObject({ state: 'off', startError: null })
  })

  it('stays off for this run when saving "off" fails', async () => {
    const { folder, port, view } = await setup({ enabled: true })
    const viewer = subscribe(port)
    await expect.poll(() => viewer.frames.length).toBe(1)
    await chmod(folder, 0o500)
    expect(await view.disable()).toEqual({ ok: false, error: 'save-failed' })
    await viewer.ended
    expect(viewer.frames.at(-1)).toEqual({ v: 1, type: 'end', reason: 'remote-off' })
    expect(await accepts(port)).toBe(false)
    expect(view.status()).toMatchObject({ state: 'off' })
    expect(await savedFile(folder)).toMatchObject({ enabled: true })
  })

  it('ends streams with access-changed on a new login and rotates the opaque IDs', async () => {
    const { port, view } = await setup({ enabled: true })
    const first = subscribe(port)
    await expect.poll(() => first.frames.length).toBe(1)
    const newLogin = 'new-owner@example.com'
    expect(await view.saveConnection({ ownerLogin: newLogin, hostName: HOST, port })).toEqual({
      ok: true
    })
    await first.ended
    expect(first.frames.at(-1)).toEqual({ v: 1, type: 'end', reason: 'access-changed' })
    expect((await send(port, { path: '/v1/status' })).status).toBe(403)
    const second = subscribe(port, { ...OWNER_HEADERS, 'Tailscale-User-Login': newLogin })
    await expect.poll(() => second.frames.length).toBe(1)
    const id = (frame: unknown) => (frame as StatusFrame).status.projects[0]!.sessions[0]!.id
    expect(id(second.frames[0])).not.toBe(id(first.frames[0]))
    const generation = (frame: unknown) => (frame as StatusFrame).generation
    expect(generation(second.frames[0])).toBeGreaterThan(generation(first.frames[0]))
  })

  it('moves to a new port and refuses the old one', async () => {
    const { port, view } = await setup({ enabled: true })
    const next = await freePort()
    expect(await view.saveConnection(connection(next))).toEqual({ ok: true })
    expect(await accepts(port)).toBe(false)
    expect((await send(next, { path: '/x' })).status).toBe(404)
  })
})

describe('Remote View quit', () => {
  it('ends streams with shutdown and leaves no listener, also during a start', async () => {
    const { port, view } = await setup({ enabled: true })
    const viewer = subscribe(port)
    await expect.poll(() => viewer.frames.length).toBe(1)
    await view.close()
    await viewer.ended
    expect(viewer.frames.at(-1)).toEqual({ v: 1, type: 'end', reason: 'shutdown' })
    expect(await accepts(port)).toBe(false)
    expect(await view.enable()).toEqual({ ok: false, error: 'cancelled' })

    const before = servers().length
    const { port: other, view: starting } = await setup({ enabled: false })
    await starting.saveConnection(connection(other))
    const enabling = starting.enable()
    await starting.close()
    expect(await enabling).toEqual({ ok: false, error: 'cancelled' })
    expect(await accepts(other)).toBe(false)
    expect(servers().length).toBe(before)
  })

  it('closes a listener whose start finishes only after quit began', async () => {
    vi.resetModules()
    let finish: ((start: RemoteListenerStart) => void) | undefined
    vi.doMock('./listener', async (importOriginal) => ({
      ...(await importOriginal<object>()),
      startRemoteListener: () =>
        new Promise<RemoteListenerStart>((resolve) => {
          finish = resolve
        })
    }))
    try {
      const { createRemoteView: create } = await import('./remote-view')
      const folder = await mkdtemp(join(tmpdir(), 'agentpeek-remote-view-'))
      folders.push(folder)
      await writeFile(
        join(folder, REMOTE_SETTINGS_FILE),
        JSON.stringify({ version: 1, enabled: true, ...connection(47613) })
      )
      const view = create({ folder, viewerFolder: folder, snapshot: () => snapshot })
      const opening = view.open()
      await vi.waitFor(() => expect(finish).toBeDefined())
      const closing = view.close()
      const closeLate = vi.fn<RemoteListener['close']>().mockResolvedValue(undefined)
      const late: RemoteListener = {
        port: 47613,
        streamCount: () => 0,
        aliasFor: () => null,
        publish: vi.fn(),
        resync: vi.fn(),
        suspend: vi.fn(),
        resume: vi.fn(),
        close: closeLate
      }
      finish!({ ok: true, listener: late })
      await closing
      expect(closeLate).toHaveBeenCalledOnce()
      await opening
      expect(view.status()).toMatchObject({ state: 'off' })
    } finally {
      vi.doUnmock('./listener')
      vi.resetModules()
    }
  })
})

// TASK-015: the saved folders and title option are the only policy, applied at every send.
const OTHER = '/Users/synthetic/projects/other-demo'
const TITLE = 'SENTINEL-TITLE synthetic plan'
const row = (id: string, workspacePath: string | null, change: Partial<Session> = {}) =>
  testSession({
    key: { tool: 'codex', id: `SENTINEL-RAW-${id}` },
    summary: { title: `${TITLE} ${id}`, workspacePath, lastActivityAt: 10, toolVersion: null },
    ...change
  })
const listing = (sessions: Session[], takenAt = 2, codex: 'connected' | 'off' = 'connected') =>
  createSnapshot({
    sessions,
    health: {
      codex: codex === 'off' ? { state: 'off' } : { state: 'connected', lastReadAt: takenAt },
      claude: { state: 'not-installed' }
    },
    localState: { kind: 'available' },
    firstLaunch: false,
    fixture: true,
    takenAt
  })
const statusFrames = (frames: RemoteFrame[]) =>
  frames.filter((frame): frame is StatusFrame => frame.type === 'status')
const labels = (frame: StatusFrame | undefined) => frame!.status.projects.map((p) => p.label)
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms))

describe('Remote View sharing policy', () => {
  it('shares nothing until a folder is added, then only that exact listed folder', async () => {
    const listed = listing([
      row('exact', SHARED),
      row('child', `${SHARED}/packages/web`),
      row('worktree', `${SHARED}-worktree`),
      row('no-folder', null),
      row('new', OTHER)
    ])
    const { folder, port, view } = await setup(
      { enabled: true, sharedWorkspaces: [] },
      () => listed
    )
    const viewer = subscribe(port)
    await expect.poll(() => viewer.frames.length).toBe(1)
    expect(statusFrames(viewer.frames)[0]!.status.projects).toEqual([])
    expect(viewer.raw.join('')).not.toContain('SENTINEL')

    for (const workspace of [
      '/Users/synthetic/projects/never-listed',
      `${SHARED}/`,
      `${SHARED}/packages`,
      'shared-demo',
      42
    ]) {
      expect(await view.shareWorkspace(workspace)).toEqual({
        ok: false,
        error: 'unknown-workspace'
      })
    }
    expect(await view.shareWorkspace(SHARED)).toEqual({ ok: true })
    await expect.poll(() => viewer.frames.length).toBe(2)
    const [before, after] = statusFrames(viewer.frames)
    expect(after!.generation).toBeGreaterThan(before!.generation)
    expect(after!.status.projects).toHaveLength(1)
    expect(after!.status.projects[0]!.sessions).toHaveLength(1)
    expect(after!.status.projects[0]!.sessions[0]!.title).toBe('Session 1')
    const text = viewer.raw.join('')
    for (const hidden of ['SENTINEL', '/Users/', OTHER]) expect(text).not.toContain(hidden)
    expect(await savedFile(folder)).toMatchObject({
      sharedWorkspaces: [SHARED],
      shareTitles: false
    })
  })

  it('adds a folder or turns titles on only once it is saved', async () => {
    const listed = listing([row('exact', SHARED)])
    const { folder, port, view } = await setup(
      { enabled: true, sharedWorkspaces: [] },
      () => listed
    )
    const viewer = subscribe(port)
    await expect.poll(() => viewer.frames.length).toBe(1)
    await chmod(folder, 0o500)
    expect(await view.shareWorkspace(SHARED)).toEqual({ ok: false, error: 'save-failed' })
    expect(await view.setShareTitles(true)).toEqual({ ok: false, error: 'save-failed' })
    await wait(REMOTE_LIMITS.minStatusIntervalMs + 100)
    expect(viewer.frames).toHaveLength(1)
    expect(view.status()).toMatchObject({ settings: { sharedWorkspaces: [], shareTitles: false } })
    // A later save never writes a change that failed.
    await chmod(folder, 0o700)
    expect(await view.saveConnection(connection(port))).toEqual({ ok: true })
    expect(await savedFile(folder)).toMatchObject({ sharedWorkspaces: [], shareTitles: false })
  })

  it('removes a folder at once, dropping a pending send, and keeps it removed when saving fails', async () => {
    let latest = listing([row('exact', SHARED), row('other', OTHER)], 2)
    const { folder, port, view } = await setup(
      { enabled: true, sharedWorkspaces: [SHARED, OTHER] },
      () => latest
    )
    const viewer = subscribe(port)
    await expect.poll(() => viewer.frames.length).toBe(1)
    expect(labels(statusFrames(viewer.frames)[0])).toEqual(['other-demo', 'shared-demo'])
    // New activity in the folder waits for the coalescing interval when the folder is removed.
    latest = listing(
      [row('exact', SHARED, { activity: { state: 'running' } }), row('other', OTHER)],
      3
    )
    view.publish(latest)
    await chmod(folder, 0o500)
    expect(await view.unshareWorkspace(SHARED)).toEqual({ ok: false, error: 'save-failed' })
    await expect.poll(() => viewer.frames.length).toBe(2)
    const [first, replaced] = statusFrames(viewer.frames)
    expect(replaced!.sentAt - first!.sentAt).toBeLessThan(REMOTE_LIMITS.minStatusIntervalMs)
    expect(replaced!.generation).toBeGreaterThan(first!.generation)
    expect(labels(replaced)).toEqual(['other-demo'])
    await wait(REMOTE_LIMITS.minStatusIntervalMs + 100)
    expect(viewer.frames).toHaveLength(2)
    expect(view.status()).toMatchObject({ settings: { sharedWorkspaces: [OTHER] } })
    expect(await savedFile(folder)).toMatchObject({ sharedWorkspaces: [SHARED, OTHER] })
    expect(await view.unshareWorkspace(SHARED)).toEqual({ ok: false, error: 'save-failed' })
  })

  it('shares titles only once saved and hides them again at once', async () => {
    const listed = listing([row('exact', SHARED)])
    const { folder, port, view } = await setup({ enabled: true }, () => listed)
    const viewer = subscribe(port)
    await expect.poll(() => viewer.frames.length).toBe(1)
    const title = (frame: StatusFrame | undefined) => frame!.status.projects[0]!.sessions[0]!.title
    expect(await view.setShareTitles('yes')).toEqual({
      ok: false,
      error: 'invalid',
      invalid: ['shareTitles']
    })
    expect(await view.setShareTitles(true)).toEqual({ ok: true })
    expect(await savedFile(folder)).toMatchObject({ shareTitles: true })
    await expect.poll(() => viewer.frames.length).toBe(2)
    expect(title(statusFrames(viewer.frames)[1])).toBe(`${TITLE} exact`)
    // Turned off inside the coalescing interval of the last status: replaced at once.
    const hiding = view.setShareTitles(false)
    await expect.poll(() => viewer.frames.length).toBe(3)
    expect(await hiding).toEqual({ ok: true })
    const [, shown, hidden] = statusFrames(viewer.frames)
    expect(hidden!.sentAt - shown!.sentAt).toBeLessThan(REMOTE_LIMITS.minStatusIntervalMs)
    expect(title(hidden)).toBe('Session 1')
    expect(hidden!.generation).toBeGreaterThan(shown!.generation)
  })

  it('clears a source turned off at once, ahead of coalescing', async () => {
    let latest = listing([row('exact', SHARED)], 2)
    const { port, view } = await setup({ enabled: true }, () => latest)
    const viewer = subscribe(port)
    await expect.poll(() => viewer.frames.length).toBe(1)
    // Even a snapshot that still lists the source's sessions shares none of them.
    latest = listing([row('exact', SHARED)], 3, 'off')
    view.publish(latest)
    await expect.poll(() => viewer.frames.length).toBe(2)
    const [first, cleared] = statusFrames(viewer.frames)
    expect(cleared!.sentAt - first!.sentAt).toBeLessThan(REMOTE_LIMITS.minStatusIntervalMs)
    expect(cleared!.generation).toBeGreaterThan(first!.generation)
    expect(cleared!.status.projects).toEqual([{ label: 'shared-demo', sessions: [] }])
    expect(cleared!.status.sources.codex).toEqual({ state: 'off' })
  })

  it('keeps every concurrent change and never exceeds 50 folders', async () => {
    const many = Array.from({ length: 51 }, (_, n) => `/Users/synthetic/projects/p${n}`)
    const listed = listing(many.map((workspace, n) => row(String(n), workspace)))
    const { folder, view } = await setup({ enabled: false, sharedWorkspaces: [] }, () => listed)
    const results = await Promise.all([
      ...many.map((workspace) => view.shareWorkspace(workspace)),
      view.setShareTitles(true)
    ])
    expect(results.filter((result) => result.ok)).toHaveLength(51)
    expect(results.filter((result) => !result.ok)).toEqual([
      { ok: false, error: 'too-many-workspaces' }
    ])
    const saved = await savedFile(folder)
    expect(saved.sharedWorkspaces).toEqual(many.slice(0, 50))
    expect(saved.shareTitles).toBe(true)
    expect(view.status()).toMatchObject({ settings: { sharedWorkspaces: many.slice(0, 50) } })
    await Promise.all([view.unshareWorkspace(many[0]), view.unshareWorkspace(many[1])])
    expect((await savedFile(folder)).sharedWorkspaces).toEqual(many.slice(2, 50))
  })
})

// TASK-019: every access change ends or replaces the affected streams before anything is awaited,
// so a send waiting for its coalescing interval never leaves afterwards.
describe('Remote View access changes during a pending send', () => {
  const NEW_LOGIN = 'new-owner@example.com'
  const busy = (takenAt: number) =>
    listing([row('exact', SHARED, { activity: { state: 'running' } })], takenAt)

  async function pending() {
    let latest = listing([row('exact', SHARED)], 2)
    const opened = await setup({ enabled: true }, () => latest)
    const viewer = subscribe(opened.port)
    await expect.poll(() => viewer.frames.length).toBe(1)
    // Inside the coalescing interval of the first status: this one waits.
    latest = busy(3)
    opened.view.publish(latest)
    return { ...opened, viewer, publish: (next: SessionsSnapshot) => (latest = next) }
  }

  it('sends only the end after OFF, never the pending status', async () => {
    const { port, view, viewer } = await pending()
    expect(await view.disable()).toEqual({ ok: true })
    await viewer.ended
    await wait(REMOTE_LIMITS.minStatusIntervalMs + 100)
    expect(viewer.frames.map((frame) => frame.type)).toEqual(['status', 'end'])
    expect(viewer.frames[1]).toEqual({ v: 1, type: 'end', reason: 'remote-off' })
    expect(await accepts(port)).toBe(false)
  })

  it('replaces the pending status when a source turns off, and sends nothing after', async () => {
    const { view, viewer, publish } = await pending()
    view.publish(publish(listing([row('exact', SHARED)], 4, 'off')))
    await expect.poll(() => viewer.frames.length).toBe(2)
    await wait(REMOTE_LIMITS.minStatusIntervalMs + 100)
    expect(viewer.frames).toHaveLength(2)
    const cleared = statusFrames(viewer.frames)[1]!
    expect(cleared.status.projects).toEqual([{ label: 'shared-demo', sessions: [] }])
    expect(cleared.status.sources.codex).toEqual({ state: 'off' })
  })

  it('ends streams on a login change before saving, so the old login gets nothing more', async () => {
    const { folder, port, view, viewer } = await pending()
    const saving = view.saveConnection({ ownerLogin: NEW_LOGIN, hostName: HOST, port })
    // Already ended, while the save is still running.
    expect(view.status()).toMatchObject({ state: 'off' })
    expect(await saving).toEqual({ ok: true })
    await viewer.ended
    await wait(REMOTE_LIMITS.minStatusIntervalMs + 100)
    expect(viewer.frames.map((frame) => frame.type)).toEqual(['status', 'end'])
    expect(viewer.frames[1]).toEqual({ v: 1, type: 'end', reason: 'access-changed' })
    expect(await savedFile(folder)).toMatchObject({ ownerLogin: NEW_LOGIN })
    expect((await send(port, { path: '/v1/status' })).status).toBe(403)
    expect(view.status()).toMatchObject({ state: 'on', settings: { ownerLogin: NEW_LOGIN } })
  })

  it('keeps listening when a second connection save overlaps the first', async () => {
    for (const second of ['third-owner@example.com', OWNER]) {
      const { folder, port, view, viewer } = await pending()
      const first = view.saveConnection({ ownerLogin: NEW_LOGIN, hostName: HOST, port })
      const last = view.saveConnection({ ownerLogin: second, hostName: HOST, port })
      expect(await first).toEqual({ ok: false, error: 'cancelled' })
      expect(await last).toEqual({ ok: true })
      await viewer.ended
      expect(view.status()).toMatchObject({ state: 'on', settings: { ownerLogin: second } })
      expect(await savedFile(folder)).toMatchObject({ enabled: true, ownerLogin: second })
      const again = subscribe(port, { ...OWNER_HEADERS, 'Tailscale-User-Login': second })
      await expect.poll(() => again.frames.length).toBe(1)
      await view.close()
    }
  })

  it('keeps the saved login when the save fails, with new opaque IDs', async () => {
    const { folder, port, view, viewer } = await pending()
    await chmod(folder, 0o500)
    expect(await view.saveConnection({ ownerLogin: NEW_LOGIN, hostName: HOST, port })).toEqual({
      ok: false,
      error: 'save-failed'
    })
    await viewer.ended
    expect(viewer.frames.at(-1)).toEqual({ v: 1, type: 'end', reason: 'access-changed' })
    expect(view.status()).toMatchObject({ state: 'on', settings: { ownerLogin: OWNER } })
    expect(await savedFile(folder)).toMatchObject({ ownerLogin: OWNER })
    const refused = await send(port, {
      path: '/v1/status',
      headers: { ...OWNER_HEADERS, 'Tailscale-User-Login': NEW_LOGIN }
    })
    expect(refused.status).toBe(403)
    const again = subscribe(port)
    await expect.poll(() => again.frames.length).toBe(1)
    const id = (frame: RemoteFrame | undefined) =>
      (frame as StatusFrame).status.projects[0]!.sessions[0]!.id
    expect(id(again.frames[0])).not.toBe(id(viewer.frames[0]))
  })
})

it('retains sleep state across enabling and requires a new full status after wake', async () => {
  const { view, port } = await setup({ enabled: false })
  view.suspend()
  expect(await view.enable()).toEqual({ ok: true })
  expect((await send(port, { path: '/v1/status' })).status).toBe(503)
  view.resume()
  const first = subscribe(port)
  await expect.poll(() => first.frames.length).toBe(1)
  view.suspend()
  await first.ended
  expect(first.frames.at(-1)).toEqual({ v: 1, type: 'end', reason: 'shutdown' })
  view.resume()
  const second = subscribe(port)
  await expect.poll(() => second.frames.length).toBe(1)
  expect(second.frames[0]).toMatchObject({ type: 'status', observedAt: 1 })
})

// TASK-041: real saved files and streams, with a deferred first write for deterministic overlap.
function holdFirstSave() {
  let release!: () => void
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const save = settingsStore.saveRemoteSettings
  vi.spyOn(settingsStore, 'saveRemoteSettings').mockImplementationOnce(async (folder, next) => {
    entered()
    await gate
    await save(folder, next)
  })
  return { release, started }
}

describe('Remote View durable recovery', () => {
  it.each(['project', 'titles'] as const)(
    'retries failed %s narrowing durably before resuming ON',
    async (kind) => {
      const { folder, port, view } = await setup({ enabled: true, shareTitles: true })
      const narrow = () =>
        kind === 'project' ? view.unshareWorkspace(SHARED) : view.setShareTitles(false)
      await chmod(folder, 0o500)
      expect(await narrow()).toEqual({ ok: false, error: 'save-failed' })
      expect(await narrow()).toEqual({ ok: false, error: 'save-failed' })
      expect(view.status()).toMatchObject({ state: 'on', unsavedChanges: true })
      const current = subscribe(port)
      await expect.poll(() => current.frames.length).toBe(1)
      const projects = (current.frames[0] as StatusFrame).status.projects
      if (kind === 'project') expect(projects).toEqual([])
      else expect(projects[0]!.sessions[0]!.title).toBe('Session 1')
      await chmod(folder, 0o700)
      expect(await narrow()).toEqual({ ok: true })
      expect(view.status()).not.toHaveProperty('unsavedChanges')
      await view.close()
      const restarted = createRemoteView({ folder, viewerFolder: folder, snapshot: () => snapshot })
      views.push(restarted)
      await restarted.open()
      expect(restarted.status()).toMatchObject({ state: 'on', resumed: true })
      const resumed = subscribe(port)
      await expect.poll(() => resumed.frames.length).toBe(1)
      const resumedProjects = (resumed.frames[0] as StatusFrame).status.projects
      if (kind === 'project') expect(resumedProjects).toEqual([])
      else expect(resumedProjects[0]!.sessions[0]!.title).toBe('Session 1')
      expect(await savedFile(folder)).toMatchObject(
        kind === 'project' ? { sharedWorkspaces: [] } : { shareTitles: false }
      )
    }
  )

  it.each([false, true])(
    'hands pending enable to a connection save (changed: %s)',
    async (changed) => {
      const { folder, port, view } = await setup({ enabled: false })
      const held = holdFirstSave()
      const enabling = view.enable()
      await held.started
      expect(view.status()).toMatchObject({ pending: true, requestedEnabled: true })
      const next = { ...connection(port), ownerLogin: changed ? 'new-owner@example.com' : OWNER }
      const saving = view.saveConnection(next)
      held.release()
      expect(await enabling).toEqual({ ok: false, error: 'cancelled' })
      expect(await saving).toEqual({ ok: true })
      expect(view.status()).toMatchObject({ state: 'on', settings: { enabled: true, ...next } })
      expect(view.status()).not.toHaveProperty('pending')
      expect(await savedFile(folder)).toMatchObject({ enabled: true, ...next })
      const viewer = subscribe(port, { ...OWNER_HEADERS, 'Tailscale-User-Login': next.ownerLogin })
      await expect.poll(() => viewer.frames.length).toBe(1)
    }
  )

  it.each(['off', 'quit'] as const)(
    'never starts superseded work after %s during enable/save',
    async (end) => {
      const { folder, port, view } = await setup({ enabled: false })
      const held = holdFirstSave()
      const enabling = view.enable()
      await held.started
      const saving = view.saveConnection(connection(port))
      const ending = end === 'off' ? view.disable() : view.close()
      held.release()
      expect(await enabling).toEqual({ ok: false, error: 'cancelled' })
      expect(await saving).toEqual({ ok: false, error: 'cancelled' })
      await ending
      expect(await accepts(port)).toBe(false)
      expect(await savedFile(folder)).toMatchObject({ enabled: false })
    }
  )

  it.each(['project', 'titles'] as const)(
    'does not apply stale %s widening after narrowing',
    async (kind) => {
      const { folder, port, view } = await setup({ enabled: true, sharedWorkspaces: [] })
      const held = holdFirstSave()
      const widening = kind === 'project' ? view.shareWorkspace(SHARED) : view.setShareTitles(true)
      await held.started
      const narrowing =
        kind === 'project' ? view.unshareWorkspace(SHARED) : view.setShareTitles(false)
      held.release()
      expect(await widening).toEqual({ ok: false, error: 'cancelled' })
      expect(await narrowing).toEqual({ ok: true })
      expect(await savedFile(folder)).toMatchObject({ sharedWorkspaces: [], shareTitles: false })
      const viewer = subscribe(port)
      await expect.poll(() => viewer.frames.length).toBe(1)
      expect((viewer.frames[0] as StatusFrame).status.projects).toEqual([])
    }
  )

  it('distinguishes saved connection values from an occupied-port restart failure', async () => {
    const { folder, port, view } = await setup({ enabled: true })
    const busy = await freePort()
    const other = createServer()
    await new Promise<void>((resolve) => other.listen(busy, '127.0.0.1', resolve))
    try {
      const next = { ...connection(busy), ownerLogin: 'new-owner@example.com' }
      expect(await view.saveConnection(next)).toEqual({
        ok: false,
        error: 'port-in-use',
        connectionSaved: true
      })
      expect(view.status()).toMatchObject({
        state: 'off',
        settings: { ...next, enabled: false },
        startError: 'port-in-use'
      })
      expect(await savedFile(folder)).toMatchObject({ ...next, enabled: false })
      expect(await accepts(port)).toBe(false)
      expect(await view.saveConnection(connection(port))).toEqual({ ok: true })
      expect(await view.enable()).toEqual({ ok: true })
    } finally {
      await new Promise<void>((resolve) => other.close(() => resolve()))
    }
  })
})

it('reports both a failed connection save and a failed restart without hiding unsaved OFF', async () => {
  const { folder, port, view } = await setup({ enabled: true })
  const other = createServer()
  const save = settingsStore.saveRemoteSettings
  await chmod(folder, 0o500)
  vi.spyOn(settingsStore, 'saveRemoteSettings').mockImplementationOnce(async (target, next) => {
    try {
      await save(target, next)
    } catch {
      await new Promise<void>((resolve) => other.listen(port, '127.0.0.1', resolve))
      throw new Error('Synthetic save failure')
    }
  })
  try {
    expect(
      await view.saveConnection({ ...connection(port), ownerLogin: 'new-owner@example.com' })
    ).toEqual({ ok: false, error: 'save-failed' })
    expect(view.status()).toMatchObject({
      state: 'off',
      settings: { ownerLogin: OWNER, enabled: false },
      startError: 'port-in-use',
      unsavedChanges: true
    })
    expect(await savedFile(folder)).toMatchObject({ ownerLogin: OWNER, enabled: true })
  } finally {
    await new Promise<void>((resolve) => other.close(() => resolve()))
  }
})

it('coalesces repeated enable requests until the first real save result', async () => {
  const { folder, view } = await setup({ enabled: false })
  const held = holdFirstSave()
  const first = view.enable()
  await held.started
  const second = view.enable()
  expect(first).toBe(second)
  await chmod(folder, 0o500)
  held.release()
  expect(await first).toEqual({ ok: false, error: 'save-failed' })
  expect(await second).toEqual({ ok: false, error: 'save-failed' })
  expect(view.status()).toMatchObject({ state: 'off' })
})

// TASK-042: the desktop follows the runtime status and shows the viewer's alias.
describe('Remote View desktop status', () => {
  it('announces each changed status: resume, viewer pages, OFF and quit', async () => {
    const onChange = vi.fn<NonNullable<RemoteViewOptions['onChange']>>()
    const { port, view } = await setup({ enabled: true }, () => snapshot, onChange)
    const states = () =>
      onChange.mock.calls.map(([status]) =>
        status.state === 'on' ? `on:${status.streams}` : status.state
      )
    expect(states().at(-1)).toBe('on:0')
    expect(onChange.mock.lastCall![0]).toMatchObject({ state: 'on', resumed: true })
    const viewer = subscribe(port)
    await expect.poll(() => states().at(-1)).toBe('on:1')
    viewer.disconnect()
    await expect.poll(() => states().at(-1)).toBe('on:0')
    // An unchanged status is not announced again.
    const count = onChange.mock.calls.length
    view.publish(snapshot)
    expect(onChange).toHaveBeenCalledTimes(count)
    await view.disable()
    expect(states().at(-1)).toBe('off')
    expect(states()).not.toContain('loading')
    await view.enable()
    expect(states().at(-1)).toBe('on:0')
    await view.close()
    expect(states().at(-1)).toBe('off')
  })

  it('announces a failed start as off with its error, never as on', async () => {
    const blocker = createServer()
    const port = await freePort()
    await new Promise<void>((resolve) => blocker.listen(port, '127.0.0.1', resolve))
    try {
      const onChange = vi.fn<NonNullable<RemoteViewOptions['onChange']>>()
      const folder = await mkdtemp(join(tmpdir(), 'agentpeek-remote-view-'))
      folders.push(folder)
      await writeFile(
        join(folder, REMOTE_SETTINGS_FILE),
        JSON.stringify({ version: 1, enabled: true, ...connection(port) })
      )
      const view = createRemoteView({
        folder,
        viewerFolder: folder,
        snapshot: () => snapshot,
        onChange
      })
      views.push(view)
      await view.open()
      expect(onChange.mock.calls.map(([status]) => status.state)).not.toContain('on')
      expect(onChange.mock.lastCall![0]).toMatchObject({ state: 'off', startError: 'port-in-use' })
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()))
    }
  })

  it('gives the viewer alias only while on, sharing that folder, with titles hidden', async () => {
    const ids = ['a', 'b', 'c'].map((id) => `SENTINEL-RAW-${id}`)
    const key = { tool: 'codex', id: ids[0]! } as const
    const many = listing(['a', 'b', 'c'].map((id) => row(id, SHARED)))
    const { port, view } = await setup({ enabled: true }, () => many)
    const viewer = subscribe(port)
    await expect.poll(() => viewer.frames.length).toBe(1)
    const frame = viewer.frames[0] as StatusFrame
    const aliases = ids.map((id) => view.aliasFor({ tool: 'codex', id }))
    expect(new Set(aliases)).toEqual(
      new Set(frame.status.projects[0]!.sessions.map((session) => session.title))
    )
    expect(await view.setShareTitles(true)).toEqual({ ok: true })
    expect(view.aliasFor(key)).toBeNull()
    expect(await view.setShareTitles(false)).toEqual({ ok: true })
    expect(await view.unshareWorkspace(SHARED)).toEqual({ ok: true })
    expect(view.aliasFor(key)).toBeNull()
    await view.disable()
    expect(view.aliasFor(key)).toBeNull()
  })
})
