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
import { createRemoteView, type RemoteView } from './remote-view'
import { REMOTE_SETTINGS_FILE } from './settings'

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
async function setup(saved?: object, current: () => SessionsSnapshot = () => snapshot) {
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
    snapshot: current
  })
  views.push(view)
  await view.open()
  return { folder, port, view }
}
afterEach(async () => {
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
        publish: vi.fn(),
        resync: vi.fn(),
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
    expect(await view.unshareWorkspace(SHARED)).toEqual({ ok: true })
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
