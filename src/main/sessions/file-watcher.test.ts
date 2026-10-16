import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import {
  appendFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentTool } from '../../core/tools'
import { type AccessGate, AccessRefusedError, createAccessGate } from './access'
import { codexPaths } from './codex-files'
import {
  type ChangeListener,
  createFileWatcher,
  type FolderWatch,
  type SessionWatcher,
  type WatchFunction
} from './file-watcher'
import { sessionFolderWatches } from './watch-folders'

// The lstat spy shows which paths the watcher looked at, and can hold a look-up back.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, lstat: vi.fn(actual.lstat) }
})

// Synthetic files in a temporary folder. Most tests drive a fake `fs.watch`, so each event is
// exactly the one the test sends; the last group runs the real `fs.watch`.
const DELAY_MS = 5

/** A watch the fake `fs.watch` started. */
interface FakeWatch {
  path: string
  recursive: boolean
  closed: boolean
  emit(event: string, name?: string | null): void
  fail(): void
}

type Gate = Pick<AccessGate, 'resolve'>

/** A gate that allows every path. The tests of the real gate build a real home folder. */
const ALLOW_ALL: Gate = { resolve: (path) => Promise.resolve(path) }

let root: string
let watches: FakeWatch[]
/** Every path the fake `fs.watch` was asked to watch, refused or not. */
let attempts: string[]
/** Paths the fake `fs.watch` refuses, as if they were missing. */
let unwatchable: Set<string>
let listener: ReturnType<typeof vi.fn<ChangeListener>>
let watcher: SessionWatcher | null
/** Writers that unblock a named pipe if a test's watcher ever waits on one. */
let valves: ChildProcess[]

const fakeWatch: WatchFunction = (path, recursive, onEvent, onError) => {
  attempts.push(path)
  if (unwatchable.has(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
  const watch: FakeWatch = {
    path,
    recursive,
    closed: false,
    emit: (event, name = null) => {
      if (!watch.closed) onEvent(event, name)
    },
    fail: () => {
      if (!watch.closed) onError()
    }
  }
  watches.push(watch)
  return {
    close: () => {
      watch.closed = true
    }
  }
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'agentpeek-watcher-')))
  await mkdir(join(root, 'logs'))
  await mkdir(join(root, 'registry'))
  watches = []
  attempts = []
  unwatchable = new Set()
  listener = vi.fn<ChangeListener>()
  watcher = null
  valves = []
  vi.mocked(lstat).mockClear()
})

afterEach(async () => {
  watcher?.close()
  for (const valve of valves) valve.kill('SIGKILL')
  await rm(root, { recursive: true, force: true })
})

/** Two tools' folders: a log folder for Codex (recursive) and a JSON folder for Claude. */
function folders(): FolderWatch[] {
  return [
    {
      tool: 'codex',
      folder: join(root, 'logs'),
      recursive: true,
      accepts: (path) => path.startsWith(join(root, 'logs')) && path.endsWith('.jsonl')
    },
    {
      tool: 'claude',
      folder: join(root, 'registry'),
      recursive: false,
      accepts: (path) => /\/registry\/\d+\.json$/.test(path)
    }
  ]
}

function start(
  options: { watch?: WatchFunction; gate?: Gate; folders?: FolderWatch[] } = {}
): SessionWatcher {
  watcher = createFileWatcher({
    folders: options.folders ?? folders(),
    onChange: listener,
    gate: options.gate ?? ALLOW_ALL,
    watch: 'watch' in options ? options.watch : fakeWatch,
    delayMs: DELAY_MS
  })
  return watcher
}

/** Starts a watcher and waits for its folder watches. */
async function startWatching(options: { watch?: WatchFunction } = {}): Promise<SessionWatcher> {
  const started = start(options)
  await started.watchFolders()
  return started
}

function active(path: string): FakeWatch[] {
  return watches.filter((watch) => watch.path === path && !watch.closed)
}

async function waitForWatch(path: string, count = 1): Promise<void> {
  await vi.waitFor(() => expect(active(path)).toHaveLength(count))
}

/** Waits until the watcher has looked at a path, and a moment more for its check to finish. */
async function waitForCheck(path: string): Promise<void> {
  await vi.waitFor(() => expect(lstat).toHaveBeenCalledWith(path))
  await new Promise((resolve) => setTimeout(resolve, 20))
}

function folderWatch(tool: AgentTool): FakeWatch {
  const folder = folders().find((candidate) => candidate.tool === tool)?.folder ?? ''
  const [watch] = active(folder)
  if (watch === undefined) throw new Error(`No watch on the ${tool} folder.`)
  return watch
}

/** Every path reported so far, in order. */
function reported(): string[] {
  return listener.mock.calls.flatMap(([, paths]) => paths)
}

async function waitForReport(path: string, times = 1): Promise<void> {
  await vi.waitFor(() => {
    expect(reported().filter((candidate) => candidate === path)).toHaveLength(times)
  })
}

async function writeLog(name: string, text = 'line\n'): Promise<string> {
  const path = join(root, 'logs', name)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
  return path
}

/** Makes a named pipe, and a writer that opens it after a while, so a reader stuck on it ends. */
function namedPipe(path: string): void {
  execFileSync('/usr/bin/mkfifo', [path])
  valves.push(spawn('/bin/sh', ['-c', 'sleep 1.5; exec 3>"$1"', 'sh', path], { stdio: 'ignore' }))
}

/** The longest gap between timer callbacks over a while: how long the event loop was blocked. */
async function longestPause(ms: number): Promise<number> {
  let longest = 0
  let last = performance.now()
  const end = last + ms
  while (performance.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    const at = performance.now()
    longest = Math.max(longest, at - last)
    last = at
  }
  return longest
}

describe('folder watches', () => {
  it('reports the files a folder accepts, with their tool, and never looks at the others', async () => {
    const log = await writeLog('a.jsonl')
    const other = await writeLog('state.json.tmp')
    await startWatching()
    // The two folders are checked at the same time, so their watches start in either order.
    expect(watches.map(({ path, recursive }) => ({ path, recursive }))).toEqual(
      expect.arrayContaining([
        { path: join(root, 'logs'), recursive: true },
        { path: join(root, 'registry'), recursive: false }
      ])
    )
    expect(watches).toHaveLength(2)

    folderWatch('codex').emit('rename', 'state.json.tmp')
    folderWatch('codex').emit('change', 'a.jsonl')
    folderWatch('codex').emit('change', '../registry/1.json')
    folderWatch('codex').emit('change', null)
    await waitForReport(log)
    expect(listener.mock.calls).toEqual([['codex', [log]]])
    expect(vi.mocked(lstat).mock.calls.map(([path]) => path)).toEqual([log])
    expect(reported()).not.toContain(other)
  })

  it('gathers several events on one file into one report', async () => {
    const log = await writeLog('a.jsonl')
    await startWatching()
    for (let index = 0; index < 5; index++) folderWatch('codex').emit('rename', 'a.jsonl')
    await waitForReport(log)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('reports each tool’s files in their own call', async () => {
    const log = await writeLog('a.jsonl')
    const registry = join(root, 'registry', '1.json')
    await writeFile(registry, '{}')
    await startWatching()
    folderWatch('codex').emit('change', 'a.jsonl')
    folderWatch('claude').emit('change', '1.json')
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(2))
    expect(listener.mock.calls).toContainEqual(['codex', [log]])
    expect(listener.mock.calls).toContainEqual(['claude', [registry]])
  })

  it('starts a missing folder’s watch at a later call, once the folder exists', async () => {
    const missing = join(root, 'registry')
    await rm(missing, { recursive: true })
    const started = start()
    await started.watchFolders()
    await started.watchFolders()
    expect(attempts).not.toContain(missing)

    await mkdir(missing)
    await started.watchFolders()
    expect(active(missing)).toHaveLength(1)
    // A running watch is not started twice, even by calls at the same time.
    await Promise.all([started.watchFolders(), started.watchFolders()])
    expect(attempts.filter((path) => path === missing)).toHaveLength(1)
  })

  it('starts one watch when two calls check a folder at the same time', async () => {
    const started = start()
    await Promise.all([started.watchFolders(), started.watchFolders()])
    expect(attempts.filter((path) => path === join(root, 'logs'))).toHaveLength(1)
  })

  it('never watches a named pipe, or a symlink to one, in a folder’s place', async () => {
    const registry = join(root, 'registry')
    const logs = join(root, 'logs')
    await rm(registry, { recursive: true })
    await rm(logs, { recursive: true })
    execFileSync('/usr/bin/mkfifo', [registry])
    execFileSync('/usr/bin/mkfifo', [join(root, 'pipe')])
    await symlink(join(root, 'pipe'), logs)
    await start().watchFolders()
    expect(attempts).toEqual([])
  })

  it('watches a folder that is a symlink to a folder, as a tool’s folder may be', async () => {
    const logs = join(root, 'logs')
    await rm(logs, { recursive: true })
    await mkdir(join(root, 'elsewhere'))
    await symlink(join(root, 'elsewhere'), logs)
    await start().watchFolders()
    expect(active(logs)).toHaveLength(1)
  })

  it('starts a broken folder watch again at the next call', async () => {
    const started = await startWatching()
    const broken = folderWatch('claude')
    broken.fail()
    expect(broken.closed).toBe(true)
    await started.watchFolders()
    expect(active(broken.path)).toHaveLength(1)
  })
})

describe('events as hints', () => {
  it('reports nothing for an event on a file whose identity and size did not change', async () => {
    const log = await writeLog('a.jsonl')
    const other = await writeLog('b.jsonl')
    await startWatching()
    folderWatch('codex').emit('change', 'a.jsonl')
    await waitForReport(log)

    // Same size, even with a new modification time: an append-only log has nothing new to read.
    await utimes(log, new Date(), new Date(Date.now() + 5000))
    folderWatch('codex').emit('change', 'a.jsonl')
    folderWatch('codex').emit('change', 'b.jsonl')
    await waitForReport(other)
    expect(reported()).toEqual([log, other])

    await appendFile(log, 'more\n')
    folderWatch('codex').emit('change', 'a.jsonl')
    await waitForReport(log, 2)
  })

  it('reports a JSON file rewritten in place at the same size', async () => {
    const registry = join(root, 'registry', '1.json')
    await writeFile(registry, '{"status":"busy"}')
    await startWatching()
    folderWatch('claude').emit('change', '1.json')
    await waitForReport(registry)

    await writeFile(registry, '{"status":"idle"}')
    await utimes(registry, new Date(), new Date(Date.now() + 5000))
    folderWatch('claude').emit('change', '1.json')
    await waitForReport(registry, 2)
  })

  it('reports a file that was replaced at the same size', async () => {
    const log = await writeLog('a.jsonl', 'one\n')
    await startWatching()
    folderWatch('codex').emit('change', 'a.jsonl')
    await waitForReport(log)

    await rm(log)
    await writeLog('a.jsonl', 'two\n')
    folderWatch('codex').emit('rename', 'a.jsonl')
    await waitForReport(log, 2)
  })

  it('reports a removed file, and again once it is back', async () => {
    const log = await writeLog('a.jsonl')
    await startWatching()
    folderWatch('codex').emit('change', 'a.jsonl')
    await waitForReport(log)

    await rm(log)
    folderWatch('codex').emit('rename', 'a.jsonl')
    await waitForReport(log, 2)

    await writeLog('a.jsonl')
    folderWatch('codex').emit('rename', 'a.jsonl')
    await waitForReport(log, 3)
  })

  it('keeps reporting after the listener throws', async () => {
    const log = await writeLog('a.jsonl')
    listener.mockImplementationOnce(() => {
      throw new Error('listener failed')
    })
    await startWatching()
    folderWatch('codex').emit('change', 'a.jsonl')
    await waitForReport(log)
    await appendFile(log, 'more\n')
    folderWatch('codex').emit('change', 'a.jsonl')
    await waitForReport(log, 2)
  })
})

describe('file watches', () => {
  it('watches each named file, reports it once when its watch starts, and stops it when dropped', async () => {
    const first = await writeLog('2026/01/15/a.jsonl')
    const second = await writeLog('2026/01/15/b.jsonl')
    const started = start()
    started.watchFiles('codex', [first, second])
    await waitForWatch(first)
    await waitForWatch(second)
    expect(active(first)[0]?.recursive).toBe(false)
    await vi.waitFor(() => expect(reported().sort()).toEqual([first, second]))

    // Naming the same files again starts nothing new and reports nothing.
    started.watchFiles('codex', [first, second])
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(watches).toHaveLength(2)

    // A thread that leaves the listed set: its watch stops.
    started.watchFiles('codex', [second])
    expect(active(first)).toHaveLength(0)
    expect(active(second)).toHaveLength(1)
  })

  it('reports an append that only the file watch sees', async () => {
    const log = await writeLog('2026/01/15/a.jsonl')
    start().watchFiles('codex', [log])
    await waitForReport(log)

    await appendFile(log, 'more\n')
    active(log)[0]?.emit('change', 'a.jsonl')
    await waitForReport(log, 2)
    expect(listener).toHaveBeenLastCalledWith('codex', [log])
  })

  it('watches the path again after a rename, and reports it', async () => {
    const log = await writeLog('2026/01/15/a.jsonl')
    start().watchFiles('codex', [log])
    await waitForReport(log)
    const first = active(log)[0]

    await appendFile(log, 'more\n')
    first?.emit('rename', 'a.jsonl')
    expect(first?.closed).toBe(true)
    await waitForWatch(log)
    expect(active(log)[0]).not.toBe(first)
    await waitForReport(log, 2)

    // An event on the old watch, delivered late, does nothing.
    await appendFile(log, 'more\n')
    first?.emit('change', 'a.jsonl')
    expect(active(log)).toHaveLength(1)
  })

  it('reports a renamed-away file, and watches it again only after a reconcile', async () => {
    const log = await writeLog('2026/01/15/a.jsonl')
    const started = start()
    started.watchFiles('codex', [log])
    await waitForReport(log)

    await rm(log)
    active(log)[0]?.emit('rename', 'a.jsonl')
    expect(active(log)).toHaveLength(0)
    await waitForReport(log, 2)
    await new Promise((resolve) => setTimeout(resolve, 20))

    // The source names it again before it noticed: no new look, and no report.
    await writeLog('2026/01/15/a.jsonl')
    const looks = vi.mocked(lstat).mock.calls.length
    started.watchFiles('codex', [log])
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(vi.mocked(lstat).mock.calls.length).toBe(looks)
    expect(active(log)).toHaveLength(0)

    await started.watchFolders()
    started.watchFiles('codex', [log])
    await waitForWatch(log)
    await waitForReport(log, 3)
  })

  it('watches a file again once an event shows it is back, after its watch failed to restart', async () => {
    const log = await writeLog('2026/01/15/a.jsonl')
    const started = await startWatching()
    started.watchFiles('codex', [log])
    await waitForReport(log)

    // The file is replaced, and its watch cannot restart at that moment.
    await rm(log)
    await writeLog('2026/01/15/a.jsonl')
    unwatchable.add(log)
    active(log)[0]?.emit('rename', 'a.jsonl')
    await vi.waitFor(() => expect(attempts.filter((path) => path === log)).toHaveLength(2))
    unwatchable.delete(log)
    await waitForReport(log, 2)

    // An event shows the file is there, so the source's next naming of it starts its watch again,
    // without waiting for a reconcile.
    await appendFile(log, 'more\n')
    folderWatch('codex').emit('change', '2026/01/15/a.jsonl')
    await waitForReport(log, 3)
    started.watchFiles('codex', [log])
    await waitForWatch(log)
    await appendFile(log, 'more\n')
    active(log)[0]?.emit('change', 'a.jsonl')
    await waitForReport(log, 4)
  })

  it('does not report a file whose watch cannot start, and tries it again only after a reconcile', async () => {
    const log = await writeLog('2026/01/15/unwatchable.jsonl')
    const sentinel = await writeLog('2026/01/15/a.jsonl')
    unwatchable.add(log)
    const started = start()
    started.watchFiles('codex', [log, sentinel])
    await waitForReport(sentinel)
    await vi.waitFor(() => expect(attempts).toContain(log))
    expect(reported()).toEqual([sentinel])

    // Its source names it again after each read; it is tried again only after a reconcile.
    started.watchFiles('codex', [log, sentinel])
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(attempts.filter((path) => path === log)).toHaveLength(1)
    await started.watchFolders()
    started.watchFiles('codex', [log, sentinel])
    await vi.waitFor(() => expect(attempts.filter((path) => path === log)).toHaveLength(2))
  })

  it('never watches a symlink, a named pipe, or a folder in a file’s place', async () => {
    const secret = join(root, 'auth.json')
    await writeFile(secret, '{}')
    const link = join(root, 'logs', 'link.jsonl')
    await symlink(secret, link)
    const pipe = join(root, 'logs', 'pipe.jsonl')
    namedPipe(pipe)
    const folder = join(root, 'logs', 'folder.jsonl')
    await mkdir(folder)
    const sentinel = await writeLog('a.jsonl')

    start().watchFiles('codex', [link, pipe, folder, sentinel])
    await waitForWatch(sentinel)
    for (const path of [link, pipe, folder]) await waitForCheck(path)
    expect(attempts).toEqual([sentinel])
    await waitForReport(sentinel)
    expect(reported()).toEqual([sentinel])
  })

  it('never watches a file the access gate refuses', async () => {
    const refused = await writeLog('refused.jsonl')
    const allowed = await writeLog('allowed.jsonl')
    const gate: Gate = {
      resolve: (path) =>
        path === refused
          ? Promise.reject(new AccessRefusedError('symlink-escape'))
          : Promise.resolve(path)
    }
    start({ gate }).watchFiles('codex', [refused, allowed])
    await waitForWatch(allowed)
    await waitForCheck(refused)
    expect(attempts).toEqual([allowed])
  })

  it('never watches a rollout reached through a symlinked folder that leads outside', async () => {
    // A real home folder and the real gate: a day folder is a symlink to a folder elsewhere.
    const home = join(root, 'home')
    const sessions = codexPaths(home).sessions
    await mkdir(join(sessions, '2026'), { recursive: true })
    await mkdir(join(root, 'elsewhere'))
    await symlink(join(root, 'elsewhere'), join(sessions, '2026', '01'))
    const outside = join(sessions, '2026', '01', 'rollout-x.jsonl')
    await writeFile(join(root, 'elsewhere', 'rollout-x.jsonl'), 'line\n')
    const inside = join(sessions, '2026', 'rollout-y.jsonl')
    await writeFile(inside, 'line\n')

    const started = start({ folders: sessionFolderWatches(home), gate: createAccessGate(home) })
    started.watchFiles('codex', [outside, inside])
    await waitForWatch(inside)
    await waitForCheck(outside)
    expect(attempts).toEqual([inside])
  })

  it('stops watching a file whose rename puts a symlink in its place', async () => {
    const log = await writeLog('2026/01/15/a.jsonl')
    const secret = join(root, 'auth.json')
    await writeFile(secret, '{}')
    start().watchFiles('codex', [log])
    await waitForReport(log)

    await rm(log)
    await symlink(secret, log)
    vi.mocked(lstat).mockClear()
    active(log)[0]?.emit('rename', 'a.jsonl')
    await waitForCheck(log)
    expect(active(log)).toHaveLength(0)
    expect(attempts).toEqual([log])
    await waitForReport(log, 2)
  })

  it('starts nothing when a file is dropped, or the watcher closes, while its check runs', async () => {
    const dropped = await writeLog('dropped.jsonl')
    const closing = await writeLog('closing.jsonl')
    const waiting: (() => void)[] = []
    const gate: Gate = {
      resolve: (path) =>
        new Promise((resolve) => {
          waiting.push(() => resolve(path))
        })
    }
    const started = start({ gate })
    started.watchFiles('codex', [dropped])
    await vi.waitFor(() => expect(waiting).toHaveLength(1))
    started.watchFiles('codex', [])
    waiting[0]?.()

    started.watchFiles('codex', [closing])
    await vi.waitFor(() => expect(waiting).toHaveLength(2))
    started.close()
    waiting[1]?.()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(attempts).toEqual([])
    expect(listener).not.toHaveBeenCalled()
  })

  it('stops a broken file watch, and starts it again after a reconcile', async () => {
    const log = await writeLog('2026/01/15/a.jsonl')
    const started = start()
    started.watchFiles('codex', [log])
    await waitForWatch(log)
    active(log)[0]?.fail()
    expect(active(log)).toHaveLength(0)
    started.watchFiles('codex', [log])
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(active(log)).toHaveLength(0)
    await started.watchFolders()
    started.watchFiles('codex', [log])
    await waitForWatch(log)
  })

  it('only looks at files that one of the tool’s folders accepts', async () => {
    const outside = join(root, 'elsewhere', 'a.jsonl')
    const key = join(root, 'registry', '1.abc.key')
    const otherTool = join(root, 'registry', '1.json')
    const started = start()
    started.watchFiles('codex', [outside, key, otherTool])
    started.watchFiles('claude', [key])
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(lstat).not.toHaveBeenCalled()
    expect(watches).toHaveLength(0)
  })

  it('keeps each tool’s file watches apart', async () => {
    const registry = join(root, 'registry', '1.json')
    await writeFile(registry, '{}')
    const log = await writeLog('a.jsonl')
    const started = start()
    started.watchFiles('claude', [registry])
    started.watchFiles('codex', [log])
    await waitForWatch(registry)
    await waitForWatch(log)
    started.watchFiles('codex', [])
    expect(active(registry)).toHaveLength(1)
    expect(active(log)).toHaveLength(0)
  })
})

describe('close', () => {
  it('stops every watch and reports nothing more, not even events gathered before', async () => {
    const log = await writeLog('a.jsonl')
    const started = await startWatching()
    started.watchFiles('codex', [log])
    await waitForWatch(log)
    listener.mockClear()
    folderWatch('codex').emit('change', 'a.jsonl')
    started.close()
    expect(watches.every((watch) => watch.closed)).toBe(true)

    await started.watchFolders()
    started.watchFiles('codex', [log])
    await new Promise((resolve) => setTimeout(resolve, DELAY_MS * 10))
    expect(watches.every((watch) => watch.closed)).toBe(true)
    expect(listener).not.toHaveBeenCalled()
  })

  it('leaves no timer behind', async () => {
    await writeLog('a.jsonl')
    const started = await startWatching()
    vi.useFakeTimers()
    try {
      folderWatch('codex').emit('change', 'a.jsonl')
      expect(vi.getTimerCount()).toBe(1)
      started.close()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops a report whose look-up was still running', async () => {
    await writeLog('a.jsonl')
    let release = (): void => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(lstat).mockImplementationOnce(async (path, options) => {
      await held
      return actual.lstat(path, options as { bigint: true })
    })
    const started = await startWatching()
    folderWatch('codex').emit('change', 'a.jsonl')
    await vi.waitFor(() => expect(lstat).toHaveBeenCalled())
    started.close()
    release()
    await new Promise((resolve) => setTimeout(resolve, DELAY_MS * 10))
    expect(listener).not.toHaveBeenCalled()
  })
})

// The real `fs.watch`: the behaviors TASK-002 found that the watcher relies on, and the named pipes
// that would block it. A pipe's writer opens it after 1.5 s, so a blocked test ends and fails
// instead of hanging.
describe('with the real fs.watch', () => {
  it('reports a new file through a folder watch', async () => {
    await mkdir(join(root, 'logs', '2026', '01', '15'), { recursive: true })
    await startWatching({ watch: undefined })
    const log = await writeLog('2026/01/15/new.jsonl')
    // macOS may take a moment to start delivering a new folder watch's events, so the file is
    // written to again until one is reported.
    await vi.waitFor(
      async () => {
        if (!reported().includes(log)) await appendFile(log, 'line\n')
        expect(reported()).toContain(log)
      },
      { timeout: 3000, interval: 250 }
    )
  })

  it('reports appends to a file its writer keeps open, through a file watch', async () => {
    const log = await writeLog('2026/01/15/open.jsonl', '')
    const started = start({ watch: undefined })
    started.watchFiles('codex', [log])
    await vi.waitFor(() => expect(reported()).toEqual([log]), { timeout: 3000 })

    const handle = await open(log, 'a')
    try {
      await handle.write('appended while open\n')
      await handle.sync()
      await vi.waitFor(() => expect(reported()).toEqual([log, log]), { timeout: 3000 })
    } finally {
      await handle.close()
    }
  })

  it('never waits on a named pipe in a watched file’s place', async () => {
    const pipe = join(root, 'logs', 'pipe.jsonl')
    namedPipe(pipe)
    const sentinel = await writeLog('a.jsonl')
    const started = start({ watch: undefined })
    started.watchFiles('codex', [pipe, sentinel])
    expect(await longestPause(400)).toBeLessThan(500)
    await vi.waitFor(() => expect(reported()).toEqual([sentinel]), { timeout: 3000 })
  })

  it('never waits on a named pipe in a watched folder’s place', async () => {
    const registry = join(root, 'registry')
    await rm(registry, { recursive: true })
    namedPipe(registry)
    const started = start({ watch: undefined })
    const startedAt = performance.now()
    await started.watchFolders()
    expect(performance.now() - startedAt).toBeLessThan(500)
  })
})
