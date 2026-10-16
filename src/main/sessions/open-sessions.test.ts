import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  utimes,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  assistantLine,
  catalogJson,
  CWD_FOLDER,
  promptLine,
  registryJson
} from '../../core/claude/test-records'
import {
  MINUTE,
  SECOND,
  sessionMetaLine,
  syntheticId,
  T0,
  taskCompleteLine,
  taskStartedLine
} from '../../core/codex/test-records'
import type { Session, SessionKey } from '../../core/session'
import type { SessionsSnapshot } from '../../core/snapshot'
import { claudePaths } from './claude-files'
import { codexPaths } from './codex-files'
import type { ChangeListener, SessionWatcher } from './file-watcher'
import { openSessionsService } from './open-sessions'
import { LIVENESS_INTERVAL_MS, type SessionsService } from './service'
import { STATE_FILE_NAME } from './state-store'

// The real sources, store, and (in the last group) watcher, on synthetic files in a temporary
// folder that stands in for the home folder. The process and app checks are fakes, and the clock
// is fixed one hour after the synthetic records start. No real tool file is read.
const NOW = T0 + 60 * MINUTE
const DAY = 24 * 60 * MINUTE

const CODEX_ID = syntheticId(0xc1)
const OLD_CODEX_ID = syntheticId(0xc2)
const CLAUDE_ID = syntheticId(0xa1)
const TURN = syntheticId(0x100)
const CLAUDE_PID = 4242

let root: string
let home: string
let stateFolder: string
let clock: number
let alive: boolean
let snapshots: SessionsSnapshot[]
let service: SessionsService | null
/** Where the fake watcher sends changed paths. */
let emit: ChangeListener
let watchedFiles: string[]

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'agentpeek-open-sessions-')))
  home = join(root, 'home')
  stateFolder = join(root, 'AgentPeek')
  clock = NOW
  alive = true
  snapshots = []
  service = null
  emit = () => undefined
  watchedFiles = []
})

afterEach(async () => {
  await service?.stop()
  vi.useRealTimers()
  await chmod(codexPaths(home).sessions, 0o755).catch(() => undefined)
  await rm(root, { recursive: true, force: true })
})

const fakeWatcher = (onChange: ChangeListener): SessionWatcher => {
  emit = onChange
  return {
    watchFolders: () => Promise.resolve(),
    watchFiles: (tool, paths) => {
      if (tool === 'codex') watchedFiles = [...paths]
    },
    close: () => {
      emit = () => undefined
    }
  }
}

async function start(options: { realWatcher?: boolean } = {}): Promise<SessionsService> {
  service = await openSessionsService({
    home,
    stateFolder,
    fixture: true,
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    isCodexAppRunning: () => Promise.resolve(true),
    probe: { isAlive: () => Promise.resolve(alive) },
    createWatcher: options.realWatcher === true ? undefined : fakeWatcher,
    now: () => clock
  })
  await service.start()
  return service
}

async function setModified(path: string, modifiedAt: number): Promise<void> {
  await utimes(path, modifiedAt / 1000, modifiedAt / 1000)
}

async function writeLines(path: string, lines: readonly string[], modifiedAt: number) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, lines.map((line) => `${line}\n`).join(''))
  await setModified(path, modifiedAt)
}

function rolloutPath(id: string): string {
  return join(
    codexPaths(home).sessions,
    '2026',
    '01',
    '15',
    `rollout-2026-01-15T09-00-00-${id}.jsonl`
  )
}

/** A Codex thread whose turn is still running: its last write was two minutes ago. */
async function writeRunningThread(id = CODEX_ID, modifiedAt = NOW - 2 * MINUTE): Promise<string> {
  const path = rolloutPath(id)
  await writeLines(
    path,
    [sessionMetaLine({ id, at: modifiedAt - SECOND }), taskStartedLine(TURN, modifiedAt)],
    modifiedAt
  )
  return path
}

function registryPath(): string {
  return join(claudePaths(home).registry, `${CLAUDE_PID}.json`)
}

async function writeRegistry(status: string): Promise<void> {
  const path = registryPath()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, registryJson({ pid: CLAUDE_PID, sessionId: CLAUDE_ID, status }))
}

/** A Claude Code session with a catalog entry and a transcript whose turn is open. */
async function writeClaudeSession(status = 'busy'): Promise<void> {
  const paths = claudePaths(home)
  await writeLines(
    join(paths.projects, CWD_FOLDER, `${CLAUDE_ID}.jsonl`),
    [promptLine('Synthetic prompt.', NOW - 2 * MINUTE, { sessionId: CLAUDE_ID })],
    NOW - 2 * MINUTE
  )
  const catalog = join(paths.catalog, 'account', 'organization', `local_${syntheticId(0xd1)}.json`)
  await mkdir(dirname(catalog), { recursive: true })
  await writeFile(
    catalog,
    catalogJson({ cliSessionId: CLAUDE_ID, lastActivityAt: NOW - 2 * MINUTE })
  )
  await setModified(catalog, NOW - 2 * MINUTE)
  await writeRegistry(status)
}

function find(snapshot: SessionsSnapshot, key: SessionKey): Session | undefined {
  return snapshot.sessions.find(
    (session) => session.key.tool === key.tool && session.key.id === key.id
  )
}

async function waitFor(check: (snapshot: SessionsSnapshot) => void): Promise<SessionsSnapshot> {
  let found: SessionsSnapshot | undefined
  await vi.waitFor(
    () => {
      const snapshot = snapshots.at(-1)
      expect(snapshot).toBeDefined()
      if (snapshot !== undefined) check(snapshot)
      found = snapshot
    },
    { timeout: 3000 }
  )
  if (found === undefined) throw new Error('No snapshot.')
  return found
}

const CODEX_KEY: SessionKey = { tool: 'codex', id: CODEX_ID }
const CLAUDE_KEY: SessionKey = { tool: 'claude', id: CLAUDE_ID }

describe('with the real sources and store', () => {
  it('finds sessions that were running before it opened, in the first read', async () => {
    await writeRunningThread()
    await writeClaudeSession()
    await start()
    const snapshot = await waitFor((latest) => {
      expect(latest.health.codex.state).toBe('connected')
      expect(latest.health.claude.state).toBe('connected')
    })
    expect(find(snapshot, CODEX_KEY)?.activity).toEqual({ state: 'running' })
    expect(find(snapshot, CLAUDE_KEY)?.activity).toEqual({ state: 'running' })
    expect(snapshot.groupCounts.running).toBe(2)
    expect(snapshot.firstLaunch).toBe(true)
    expect(snapshot.fixture).toBe(true)
    expect(watchedFiles).toEqual([rolloutPath(CODEX_ID)])
  })

  it('sees a Claude Code process that ended, at the next liveness check', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    await writeClaudeSession()
    await start()
    await waitFor((latest) => expect(find(latest, CLAUDE_KEY)?.activity.state).toBe('running'))

    alive = false
    clock += LIVENESS_INTERVAL_MS
    vi.advanceTimersByTime(LIVENESS_INTERVAL_MS)
    await waitFor((latest) =>
      expect(find(latest, CLAUDE_KEY)?.activity).toEqual({
        state: 'unknown',
        reason: 'process-ended'
      })
    )
  })

  it('follows a registry file that is removed and created again', async () => {
    await writeClaudeSession()
    await start()
    await waitFor((latest) => expect(find(latest, CLAUDE_KEY)?.activity.state).toBe('running'))

    await rm(registryPath())
    emit('claude', [registryPath()])
    await waitFor((latest) => expect(find(latest, CLAUDE_KEY)?.activity.state).toBe('idle'))

    await writeRegistry('waiting')
    emit('claude', [registryPath()])
    await waitFor((latest) => expect(find(latest, CLAUDE_KEY)?.activity.state).toBe('waiting'))
  })

  it('finds an old Codex thread that was resumed, at the next reconcile', async () => {
    await writeRunningThread()
    const old = rolloutPath(OLD_CODEX_ID)
    await writeLines(old, [sessionMetaLine({ id: OLD_CODEX_ID, at: NOW - 9 * DAY })], NOW - 9 * DAY)
    const running = await start()
    const before = await waitFor((latest) => expect(latest.health.codex.state).toBe('connected'))
    expect(find(before, { tool: 'codex', id: OLD_CODEX_ID })).toBeUndefined()

    // Codex keeps a resumed rollout open, so no folder watch reports the append.
    await appendFile(old, `${taskStartedLine(syntheticId(0x200), NOW - MINUTE)}\n`)
    await setModified(old, NOW - MINUTE)
    await running.reconcile()
    await waitFor((latest) =>
      expect(find(latest, { tool: 'codex', id: OLD_CODEX_ID })?.activity.state).toBe('running')
    )
    expect(watchedFiles.sort()).toEqual([old, rolloutPath(CODEX_ID)].sort())
  })

  it('keeps Claude Code working while Codex files cannot be read', async () => {
    await writeRunningThread()
    await writeClaudeSession()
    await chmod(codexPaths(home).sessions, 0o000)
    await start()
    const snapshot = await waitFor((latest) => {
      expect(latest.health.codex).toEqual({ state: 'no-access', lastReadAt: null })
      expect(latest.health.claude.state).toBe('connected')
    })
    expect(snapshot.sessions.map((session) => session.key)).toEqual([CLAUDE_KEY])
  })

  it('keeps pins and the baseline across launches', async () => {
    await writeRunningThread()
    const first = await start()
    await waitFor((latest) => expect(find(latest, CODEX_KEY)).toBeDefined())
    expect(first.setPinned(CODEX_KEY, true)).toBe(true)
    await first.stop()

    const saved = JSON.parse(await readFile(join(stateFolder, STATE_FILE_NAME), 'utf8')) as {
      baselines: Record<string, number>
    }
    // Claude Code is not installed in this home folder, so it has no baseline yet.
    expect(saved.baselines).toEqual({ codex: NOW })

    snapshots = []
    clock = NOW + MINUTE
    await start()
    const snapshot = await waitFor((latest) => expect(find(latest, CODEX_KEY)).toBeDefined())
    expect(find(snapshot, CODEX_KEY)?.pinned).toBe(true)
    expect(snapshot.firstLaunch).toBe(false)
  })

  it('keeps pins in memory, and the file unchanged, when the state file is from a newer version', async () => {
    const newer = JSON.stringify({ version: 2, futureField: true })
    await mkdir(stateFolder, { recursive: true })
    await writeFile(join(stateFolder, STATE_FILE_NAME), newer)
    await writeRunningThread()
    const running = await start()
    await waitFor((latest) => expect(find(latest, CODEX_KEY)).toBeDefined())

    expect(running.setPinned(CODEX_KEY, true)).toBe(true)
    const snapshot = await waitFor((latest) => expect(find(latest, CODEX_KEY)?.pinned).toBe(true))
    expect(snapshot.localState).toEqual({ kind: 'unavailable', reason: 'newer-version' })
    expect(snapshot.firstLaunch).toBe(false)
    await running.stop()
    expect(await readFile(join(stateFolder, STATE_FILE_NAME), 'utf8')).toBe(newer)
  })
})

describe('with the real watcher', () => {
  it('sees a Codex append that only the rollout’s own file watch reports', async () => {
    const rollout = await writeRunningThread()
    await start({ realWatcher: true })
    await waitFor((latest) => expect(find(latest, CODEX_KEY)?.activity.state).toBe('running'))

    // Codex appends while it keeps the file open; a folder watch sees nothing until it closes.
    const handle = await open(rollout, 'a')
    try {
      await handle.write(`${taskCompleteLine(TURN, NOW + SECOND)}\n`)
      const snapshot = await waitFor((latest) =>
        expect(find(latest, CODEX_KEY)?.activity.state).toBe('idle')
      )
      expect(find(snapshot, CODEX_KEY)?.attention.newReply).toBe(true)
    } finally {
      await handle.close()
    }
  })

  it('sees a new Claude Code reply through the folder watch', async () => {
    await writeClaudeSession('idle')
    await start({ realWatcher: true })
    await waitFor((latest) => expect(find(latest, CLAUDE_KEY)?.activity.state).toBe('idle'))

    // macOS may take a moment to start delivering new folder watches' events, so the reply is
    // written again until a snapshot shows it.
    const transcript = join(claudePaths(home).projects, CWD_FOLDER, `${CLAUDE_ID}.jsonl`)
    const reply = `${assistantLine([{ type: 'text', text: 'Synthetic reply.' }], NOW + SECOND)}\n`
    const shown = (): boolean => {
      const latest = snapshots.at(-1)
      return latest !== undefined && find(latest, CLAUDE_KEY)?.attention.newReply === true
    }
    await vi.waitFor(
      async () => {
        if (!shown()) await appendFile(transcript, reply)
        expect(shown()).toBe(true)
      },
      { timeout: 3000, interval: 250 }
    )
  })
})
