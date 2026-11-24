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
  CWD,
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
import {
  annotationText,
  conversationId,
  finalReplyLine,
  toolRequestLine,
  userInputLine
} from '../../core/antigravity/test-records'
import { projectRemoteStatus } from '../../core/remote/status-projection'
import { sourceTurnedOff } from '../../core/remote/share-policy'
import type { Session, SessionKey } from '../../core/session'
import type { SessionsSnapshot } from '../../core/snapshot'
import { annotationPath, antigravityPaths, transcriptPath } from './antigravity-files'
import { claudePaths } from './claude-files'
import { codexPaths } from './codex-files'
import type { ChangeListener, SessionWatcher } from './file-watcher'
import { openSessionsService } from './open-sessions'
import { LIVENESS_INTERVAL_MS, type SessionsService } from './service'
import { STATE_FILE_NAME } from './state-store'
import { parseStateFile } from './state-file'

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
let antigravityRunning: boolean
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
  antigravityRunning = true
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
    isAntigravityAppRunning: () => Promise.resolve(antigravityRunning),
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
const ANTIGRAVITY_ID = conversationId(0xa9)
const ANTIGRAVITY_KEY: SessionKey = { tool: 'antigravity', id: ANTIGRAVITY_ID }

function antigravityTranscript(): string {
  return transcriptPath(antigravityPaths(home), ANTIGRAVITY_ID)
}

/** An Antigravity conversation whose turn asked for a tool two minutes ago and is still open. */
async function writeAntigravityConversation(at = NOW - 2 * MINUTE): Promise<string> {
  const path = antigravityTranscript()
  await writeLines(
    path,
    [
      userInputLine({ step: 0, at: at - SECOND, text: 'Synthetic question' }),
      toolRequestLine({ step: 1, at, tools: ['run_command'] })
    ],
    at
  )
  return path
}

/** Appends a final reply to the Antigravity conversation, as Antigravity does: open, append, close. */
async function finishAntigravityTurn(step: number, at: number): Promise<void> {
  const path = antigravityTranscript()
  await appendFile(path, `${finalReplyLine({ step, at, text: 'Synthetic answer' })}\n`)
  await setModified(path, at)
}

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

    const saved = parseStateFile(await readFile(join(stateFolder, STATE_FILE_NAME), 'utf8'))
    if (saved.kind !== 'state') throw new Error('Expected saved state')
    // Claude Code is not installed in this home folder, so it has no baseline yet.
    expect(saved.data.baselines).toEqual({ codex: NOW })

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

describe('with the real Antigravity source', () => {
  it('lists an open Antigravity turn as Running only while the app runs, next to the other tools', async () => {
    await writeRunningThread()
    await writeClaudeSession()
    await writeAntigravityConversation()
    await mkdir(antigravityPaths(home).annotations, { recursive: true })
    await writeFile(
      annotationPath(antigravityPaths(home), ANTIGRAVITY_ID),
      annotationText('Fixture title')
    )
    await start()
    const snapshot = await waitFor((latest) => {
      expect(latest.health.codex.state).toBe('connected')
      expect(latest.health.claude.state).toBe('connected')
      expect(latest.health.antigravity.state).toBe('connected')
    })
    expect(find(snapshot, ANTIGRAVITY_KEY)).toMatchObject({
      activity: { state: 'running' },
      summary: { title: 'Fixture title', workspacePath: null, toolVersion: null },
      attention: { waiting: false, newReply: false, error: false }
    })
    expect(snapshot.groupCounts.running).toBe(3)
    // No Antigravity file needs its own watch.
    expect(watchedFiles).toEqual([rolloutPath(CODEX_ID)])

    antigravityRunning = false
    clock += 10 * SECOND
    await service!.reconcile()
    await waitFor((latest) =>
      expect(find(latest, ANTIGRAVITY_KEY)?.activity).toEqual({
        state: 'unknown',
        reason: 'app-not-running'
      })
    )
  })

  it('shows an open Antigravity turn as Unknown after 15 quiet minutes, at the next liveness check', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    await writeAntigravityConversation()
    await start()
    await waitFor((latest) => expect(find(latest, ANTIGRAVITY_KEY)?.activity.state).toBe('running'))
    clock = NOW + 13 * MINUTE
    vi.advanceTimersByTime(LIVENESS_INTERVAL_MS)
    await waitFor((latest) =>
      expect(find(latest, ANTIGRAVITY_KEY)?.activity).toEqual({ state: 'unknown', reason: 'quiet' })
    )
  })

  it('counts a reply as new only after the first read, keeps it read, and ignores a replay', async () => {
    await writeAntigravityConversation(NOW - 5 * MINUTE)
    await finishAntigravityTurn(2, NOW - 4 * MINUTE)
    const running = await start()
    // The reply finished before AgentPeek first read Antigravity: it counts as read.
    const first = await waitFor((latest) =>
      expect(find(latest, ANTIGRAVITY_KEY)?.activity.state).toBe('idle')
    )
    expect(find(first, ANTIGRAVITY_KEY)?.attention.newReply).toBe(false)

    clock = NOW + MINUTE
    await appendFile(
      antigravityTranscript(),
      `${userInputLine({ step: 3, at: NOW + 30 * SECOND, text: 'Next' })}\n`
    )
    await finishAntigravityTurn(4, NOW + MINUTE)
    emit('antigravity', [antigravityTranscript()])
    await waitFor((latest) => expect(find(latest, ANTIGRAVITY_KEY)?.attention.newReply).toBe(true))
    expect(running.markRead(ANTIGRAVITY_KEY)).toBe(true)
    await waitFor((latest) => expect(find(latest, ANTIGRAVITY_KEY)?.attention.newReply).toBe(false))

    // A duplicated line rewrites nothing: the same reply stays read.
    await appendFile(
      antigravityTranscript(),
      `${finalReplyLine({ step: 4, at: NOW + MINUTE, text: 'Synthetic answer' })}\n`
    )
    clock += SECOND
    emit('antigravity', [antigravityTranscript()])
    await running.reconcile()
    const after = await waitFor((latest) =>
      expect(find(latest, ANTIGRAVITY_KEY)?.activity.state).toBe('idle')
    )
    expect(find(after, ANTIGRAVITY_KEY)?.attention.newReply).toBe(false)
  })

  it('stops reading Antigravity while it is off and keeps its pin across launches', async () => {
    await writeAntigravityConversation()
    const first = await start()
    await waitFor((latest) => expect(find(latest, ANTIGRAVITY_KEY)).toBeDefined())
    expect(first.setPinned(ANTIGRAVITY_KEY, true)).toBe(true)
    await first.setSourceEnabled('antigravity', false)
    const off = await waitFor((latest) =>
      expect(latest.health.antigravity).toEqual({ state: 'off' })
    )
    expect(find(off, ANTIGRAVITY_KEY)).toBeUndefined()
    // A change reported while off finds nothing to read.
    await finishAntigravityTurn(2, NOW)
    emit('antigravity', [antigravityTranscript()])
    expect(await first.recentMessages(ANTIGRAVITY_KEY, 20)).toEqual({ kind: 'not-found' })
    await first.stop()

    const saved = parseStateFile(await readFile(join(stateFolder, STATE_FILE_NAME), 'utf8'))
    if (saved.kind !== 'state') throw new Error('Expected saved state')
    expect(saved.data.sessions.map((entry) => [entry.tool, entry.id, entry.pinned])).toEqual([
      ['antigravity', ANTIGRAVITY_ID, true]
    ])
    expect(JSON.stringify(saved)).not.toContain('Synthetic')

    // Ten days later the conversation is outside the 7-day range: only its pin lists it.
    snapshots = []
    clock = NOW + 10 * DAY
    const second = await start()
    const snapshot = await waitFor((latest) =>
      expect(find(latest, ANTIGRAVITY_KEY)?.activity.state).toBe('idle')
    )
    expect(find(snapshot, ANTIGRAVITY_KEY)?.unavailable).toBeUndefined()
    expect(find(snapshot, ANTIGRAVITY_KEY)?.pinned).toBe(true)
    const messages = await second.recentMessages(ANTIGRAVITY_KEY, 20)
    expect(messages.kind).toBe('messages')
  })

  it('keeps Antigravity out of a Remote View projection of a three-source snapshot', async () => {
    await writeRunningThread()
    await writeClaudeSession()
    await writeAntigravityConversation()
    await start()
    const snapshot = await waitFor((latest) => {
      expect(find(latest, CODEX_KEY)).toBeDefined()
      expect(find(latest, CLAUDE_KEY)).toBeDefined()
      expect(find(latest, ANTIGRAVITY_KEY)).toBeDefined()
    })
    const minted: SessionKey[] = []
    const status = projectRemoteStatus(snapshot, {
      sharedWorkspaces: [CWD],
      shareTitles: true,
      mintId: (key) => {
        minted.push(key)
        return `opaque-${minted.length}`
      }
    })
    expect(status.projects.flatMap((project) => project.sessions)).toHaveLength(2)
    expect(Object.keys(status.sources).sort()).toEqual(['claude', 'codex'])
    expect(minted.every((key) => key.tool !== 'antigravity')).toBe(true)
    expect(JSON.stringify(status)).not.toContain(ANTIGRAVITY_ID)
    expect(JSON.stringify(status)).not.toContain('antigravity')

    // Turning only Antigravity off is not a source change for Remote View.
    await service!.setSourceEnabled('antigravity', false)
    const off = await waitFor((latest) => expect(latest.health.antigravity.state).toBe('off'))
    expect(sourceTurnedOff(snapshot, off)).toBe(false)
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

describe('with the real watcher and Antigravity', () => {
  it('sees a new conversation and its reply through the brain folder watch', async () => {
    await mkdir(antigravityPaths(home).brain, { recursive: true })
    await mkdir(antigravityPaths(home).annotations, { recursive: true })
    await start({ realWatcher: true })
    await waitFor((latest) => expect(latest.health.antigravity.state).toBe('connected'))

    // A new conversation folder appears after the watch started.
    await writeAntigravityConversation(NOW)
    await waitFor((latest) => expect(find(latest, ANTIGRAVITY_KEY)?.activity.state).toBe('running'))

    // macOS may take a moment to deliver events for a new folder, so the step is appended again
    // (a replayed step is ignored) until a snapshot shows the reply.
    let step = 2
    const shown = (): boolean => {
      const latest = snapshots.at(-1)
      return latest !== undefined && find(latest, ANTIGRAVITY_KEY)?.attention.newReply === true
    }
    await vi.waitFor(
      async () => {
        if (!shown()) await finishAntigravityTurn(step++, NOW + SECOND)
        expect(shown()).toBe(true)
      },
      { timeout: 3000, interval: 250 }
    )
    expect(find(snapshots.at(-1)!, ANTIGRAVITY_KEY)?.activity.state).toBe('idle')
  })
})

describe('durable pins', () => {
  it('keeps pins across aging, restart, source deletion and recovery without storing conversation data', async () => {
    const path = await writeRunningThread()
    await writeClaudeSession('idle')
    const app = await start()
    await waitFor((s) => expect(s.sessions).toHaveLength(2))
    expect(app.setPinned(CODEX_KEY, true)).toBe(true)
    expect(app.setPinned(CLAUDE_KEY, true)).toBe(true)
    await app.stop()
    clock += 100 * DAY
    const reopened = await start()
    await waitFor((s) => {
      expect(s.sessions).toHaveLength(2)
      expect(s.sessions.every((session) => session.pinned && !session.unavailable)).toBe(true)
    })
    await rm(path)
    await rm(join(claudePaths(home).projects, CWD_FOLDER, `${CLAUDE_ID}.jsonl`))
    await reopened.reconcile()
    await waitFor((s) => expect(s.sessions.every((session) => session.unavailable)).toBe(true))
    expect(await reopened.recentMessages(CODEX_KEY, 20)).toEqual({ kind: 'not-found' })
    await reopened.stop()
    const missing = await start()
    await waitFor((s) =>
      expect(s.sessions.filter((session) => session.unavailable)).toHaveLength(2)
    )
    await writeRunningThread()
    await missing.reconcile()
    await waitFor((s) => expect(find(s, CODEX_KEY)?.unavailable).toBeUndefined())
    expect(missing.setPinned(CLAUDE_KEY, false)).toBe(true)
    await waitFor((s) => expect(find(s, CLAUDE_KEY)).toBeUndefined())
    await missing.stop()
    const saved = parseStateFile(await readFile(join(stateFolder, STATE_FILE_NAME), 'utf8'))
    if (saved.kind !== 'state') throw new Error('Expected saved state')
    expect(
      saved.data.sessions.every(
        (entry) =>
          Object.keys(entry).sort().join(',') ===
          'acknowledgedErrorCursor,id,lastListedAt,pinned,seenCursor,tool'
      )
    ).toBe(true)
  })
})
