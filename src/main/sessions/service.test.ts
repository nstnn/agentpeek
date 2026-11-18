import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolHealth } from '../../core/health'
import {
  EMPTY_LOCAL_STATE,
  type SessionFacts,
  type SessionKey,
  type SessionLocalState,
  type SessionReply,
  sessionKeyToString
} from '../../core/session'
import type { LocalStateStatus, SessionsSnapshot } from '../../core/snapshot'
import type { AgentTool } from '../../core/tools'
import type { ChangeListener, SessionWatcher } from './file-watcher'
import {
  createSessionsService,
  LIVENESS_INTERVAL_MS,
  MAX_RANGE_DOUBLINGS,
  SNAPSHOT_INTERVAL_MS,
  type SessionsService,
  STOP_SAVE_LIMIT_MS
} from './service'
import type { RecentMessages, SessionSource } from './session-source'
import { isStoredId } from './state-file'
import type { StateStore } from './state-store'
import type { SkillContent } from '../../core/skills'

// The service with fake sources, a fake watcher, and a fake store, on fake timers. Every ID, path,
// and time is synthetic. The real parts are put together in open-sessions.test.ts.
const NOW = Date.UTC(2026, 0, 15, 10, 0, 0)
const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const CONNECTED: ToolHealth = { state: 'connected', lastReadAt: NOW }

function id(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
}

function rollout(n: number): string {
  return `/Users/synthetic/.codex/sessions/2026/01/15/rollout-${id(n)}.jsonl`
}

function reply(
  cursor: string,
  completedAt: number,
  change: Partial<SessionReply> = {}
): SessionReply {
  return {
    cursor,
    completedAt,
    isError: false,
    errorCode: null,
    newerTurnStarted: false,
    ...change
  }
}

function codexFacts(n: number, change: Partial<SessionFacts> = {}): SessionFacts {
  return {
    key: { tool: 'codex', id: id(n) },
    summary: {
      title: 'Synthetic thread',
      workspacePath: '/Users/synthetic/projects/demo',
      lastActivityAt: NOW - MINUTE,
      toolVersion: '0.162.0'
    },
    turn: { kind: 'codex', lastTurnEvent: 'ended', appRunning: true },
    lastReply: null,
    ...change
  }
}

function claudeFacts(n: number, change: Partial<SessionFacts> = {}): SessionFacts {
  return {
    key: { tool: 'claude', id: id(n) },
    summary: {
      title: 'Synthetic session',
      workspacePath: '/Users/synthetic/projects/demo',
      lastActivityAt: NOW - MINUTE,
      toolVersion: '2.1.295'
    },
    turn: { kind: 'claude', registry: null },
    lastReply: null,
    ...change
  }
}

const RUNNING_CODEX = { kind: 'codex', lastTurnEvent: 'started', appRunning: true } as const
const BUSY_CLAUDE = {
  kind: 'claude',
  registry: { status: 'busy', waitingFor: null, ownerAlive: true }
} as const

/** What happened, in order, across the fakes. */
let log: string[]

interface FakeSource {
  source: SessionSource
  /** What the next read returns. */
  facts: SessionFacts[]
  /** The health each read sets. */
  readHealth: ToolHealth
  /** What `watchedFiles()` returns. */
  watched: string[]
  /** What `olderAvailable()` returns. */
  older: boolean
  catalog: ReturnType<typeof vi.fn<SessionSource['catalog']>>
  refresh: ReturnType<typeof vi.fn<SessionSource['refresh']>>
  recentMessages: ReturnType<typeof vi.fn<SessionSource['recentMessages']>>
}

function fakeSource(tool: AgentTool): FakeSource {
  let health: ToolHealth = { state: 'checking' }
  const fake: FakeSource = {
    facts: [],
    readHealth: CONNECTED,
    watched: [],
    older: false,
    catalog: vi.fn(() => {
      log.push(`${tool}:catalog`)
      return read()
    }),
    refresh: vi.fn((paths: readonly string[]) => {
      log.push(`${tool}:refresh:${paths.length}`)
      return read()
    }),
    recentMessages: vi.fn(() => Promise.resolve<RecentMessages>({ kind: 'not-found' })),
    source: undefined as unknown as SessionSource
  }
  function read(): Promise<SessionFacts[]> {
    health = fake.readHealth
    return Promise.resolve([...fake.facts])
  }
  fake.source = {
    tool,
    catalog: fake.catalog,
    refresh: fake.refresh,
    recentMessages: fake.recentMessages,
    health: () => health,
    watchedFiles: () => [...fake.watched],
    olderAvailable: () => fake.older
  }
  return fake
}

interface FakeWatcher extends SessionWatcher {
  /** Sends changed paths to the service, as the real watcher does after its delay. */
  emit(tool: AgentTool, paths: string[]): void
  /** Sends changed paths even after close, which the real watcher never does. */
  emitLate(tool: AgentTool, paths: string[]): void
  files: Partial<Record<AgentTool, string[]>>
  closed: boolean
}

function fakeWatcher(onChange: ChangeListener): FakeWatcher {
  const fake: FakeWatcher = {
    files: {},
    closed: false,
    emit: (tool, paths) => {
      if (!fake.closed) onChange(tool, paths)
    },
    emitLate: (tool, paths) => {
      onChange(tool, paths)
    },
    // Calls are logged even after close, so a test can see that the service made none.
    watchFolders: () => {
      log.push('watchFolders')
      return Promise.resolve()
    },
    watchFiles: (tool, paths) => {
      log.push(`${tool}:watchFiles:${paths.length}`)
      if (!fake.closed) fake.files[tool] = [...paths]
    },
    close: () => {
      fake.closed = true
      log.push('watcher:close')
    }
  }
  return fake
}

interface FakeStore extends StateStore {
  /** Changes the status as a save attempt would, and tells the listener. */
  failSaves(status: LocalStateStatus): void
  setLocalState: ReturnType<typeof vi.fn<StateStore['setLocalState']>>
  setBaseline: ReturnType<typeof vi.fn<StateStore['setBaseline']>>
  noteListed: ReturnType<typeof vi.fn<StateStore['noteListed']>>
  flush: ReturnType<typeof vi.fn<StateStore['flush']>>
}

/** An in-memory store with the real store's checks. It keeps changes in memory whatever its status. */
function fakeStore(
  options: { baselines?: Partial<Record<AgentTool, number>>; status?: LocalStateStatus } = {}
): FakeStore {
  const sessions = new Map<string, SessionLocalState>()
  const baselines = { ...options.baselines }
  let status = options.status ?? { kind: 'available' }
  let listener: (() => void) | null = null
  return {
    status: () => status,
    setStatusListener: (next) => {
      listener = next
    },
    failSaves: (next) => {
      status = next
      listener?.()
    },
    pinnedKeys: () =>
      [...sessions.entries()]
        .filter(([, local]) => local.pinned)
        .map(([key]) => {
          const colon = key.indexOf(':')
          return { tool: key.slice(0, colon) as AgentTool, id: key.slice(colon + 1) }
        }),
    localState: (key) => sessions.get(sessionKeyToString(key)) ?? EMPTY_LOCAL_STATE,
    setLocalState: vi.fn((key: SessionKey, local: SessionLocalState) => {
      if (!isStoredId(key.id)) throw new TypeError('A session key has an unexpected shape.')
      sessions.set(sessionKeyToString(key), local)
    }),
    baseline: (tool) => baselines[tool],
    setBaseline: vi.fn((tool: AgentTool, at: number) => {
      baselines[tool] = at
    }),
    noteListed: vi.fn(),
    flush: vi.fn(() => {
      log.push('store:flush')
      return Promise.resolve()
    })
  }
}

let codex: FakeSource
let claude: FakeSource
let store: FakeStore
let watcher: FakeWatcher | null
let snapshots: SessionsSnapshot[]
let service: SessionsService | null

beforeEach(() => {
  vi.useFakeTimers({ now: NOW })
  log = []
  codex = fakeSource('codex')
  claude = fakeSource('claude')
  store = fakeStore({ baselines: { codex: NOW - HOUR, claude: NOW - HOUR } })
  watcher = null
  snapshots = []
  service = null
})

afterEach(async () => {
  await service?.stop()
  vi.useRealTimers()
})

function create(
  options: { fixture?: boolean; enabledSources?: { codex: boolean; claude: boolean } } = {}
): SessionsService {
  service = createSessionsService({
    sources: [codex.source, claude.source],
    store,
    createWatcher: (onChange) => {
      watcher = fakeWatcher(onChange)
      return watcher
    },
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    fixture: options.fixture ?? false,
    enabledSources: options.enabledSources,
    now: () => Date.now()
  })
  return service
}

async function started(
  options: { fixture?: boolean; enabledSources?: { codex: boolean; claude: boolean } } = {}
): Promise<SessionsService> {
  const running = create(options)
  await running.start()
  return running
}

function theWatcher(): FakeWatcher {
  if (watcher === null) throw new Error('No watcher was created.')
  return watcher
}

/** Lets pending reads finish, and the publish pause end. */
async function settle(ms = SNAPSHOT_INTERVAL_MS): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

function latest(): SessionsSnapshot {
  const snapshot = snapshots.at(-1)
  if (snapshot === undefined) throw new Error('Nothing was published.')
  return snapshot
}

function sessionIn(snapshot: SessionsSnapshot, key: SessionKey) {
  return snapshot.sessions.find(
    (session) => sessionKeyToString(session.key) === sessionKeyToString(key)
  )
}

describe('before the first read', () => {
  it('has a "Checking…" snapshot and publishes nothing', () => {
    store = fakeStore()
    const fresh = create({ fixture: true })
    expect(fresh.snapshot()).toMatchObject({
      sessions: [],
      needsAttention: 0,
      health: { codex: { state: 'checking' }, claude: { state: 'checking' } },
      localState: { kind: 'available' },
      firstLaunch: true,
      fixture: true,
      takenAt: NOW
    })
    expect(snapshots).toEqual([])
  })

  it('is not a first launch while the saved state cannot be loaded, which the banner shows', () => {
    for (const reason of ['newer-version', 'unreadable'] as const) {
      store = fakeStore({ status: { kind: 'unavailable', reason } })
      expect(create().snapshot()).toMatchObject({
        localState: { kind: 'unavailable', reason },
        firstLaunch: false
      })
    }
  })

  it('is not a first launch once a tool has a saved baseline', () => {
    store = fakeStore({ baselines: { claude: NOW - HOUR } })
    expect(create().snapshot().firstLaunch).toBe(false)
  })

  it('needs a source for each tool', () => {
    expect(() =>
      createSessionsService({
        sources: [codex.source],
        store,
        createWatcher: fakeWatcher,
        onSnapshot: () => undefined,
        fixture: false
      })
    ).toThrow('No source for claude.')
  })
})

describe('start', () => {
  it('watches the folders, reads both tools, and publishes the running sessions', async () => {
    codex.facts = [codexFacts(1, { turn: RUNNING_CODEX }), codexFacts(2)]
    claude.facts = [claudeFacts(3, { turn: BUSY_CLAUDE })]
    await started()
    await settle()

    expect(log.slice(0, 3)).toEqual(['watchFolders', 'codex:catalog', 'claude:catalog'])
    const snapshot = latest()
    expect(snapshot.health).toEqual({ codex: CONNECTED, claude: CONNECTED })
    expect(snapshot.sessions.map((session) => session.activity.state).sort()).toEqual([
      'idle',
      'running',
      'running'
    ])
    expect(snapshot.groupCounts).toMatchObject({ running: 2, all: 3 })
    expect(store.noteListed).toHaveBeenLastCalledWith(
      expect.arrayContaining([codexFacts(1).key, codexFacts(2).key, claudeFacts(3).key])
    )
  })

  it('reads only after the folder watches are running', async () => {
    let foldersRunning = (): void => undefined
    const running = create()
    theWatcher().watchFolders = () =>
      new Promise((resolve) => {
        foldersRunning = resolve
      })
    const starting = running.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(codex.catalog).not.toHaveBeenCalled()
    foldersRunning()
    await starting
    expect(codex.catalog).toHaveBeenCalledTimes(1)
    expect(claude.catalog).toHaveBeenCalledTimes(1)
  })

  it('starts the file watches each source names', async () => {
    codex.watched = [rollout(1), rollout(2)]
    await started()
    expect(theWatcher().files).toEqual({ codex: [rollout(1), rollout(2)], claude: [] })
  })

  it('runs once, however often it is called', async () => {
    const running = await started()
    await running.start()
    expect(codex.catalog).toHaveBeenCalledTimes(1)
  })
})

describe('changes from the watcher', () => {
  it('sends a changed path to its own tool’s source, and updates only that session', async () => {
    codex.facts = [codexFacts(1), codexFacts(2)]
    claude.facts = [claudeFacts(3)]
    await started()
    await settle()
    const before = latest()

    codex.facts = [
      codexFacts(1, {
        lastReply: reply(id(0x101), NOW),
        summary: { ...codexFacts(1).summary, lastActivityAt: NOW }
      }),
      codexFacts(2)
    ]
    theWatcher().emit('codex', [rollout(1)])
    await settle()

    expect(codex.refresh).toHaveBeenCalledExactlyOnceWith([rollout(1)])
    expect(claude.refresh).not.toHaveBeenCalled()
    const after = latest()
    expect(after).not.toBe(before)
    expect(sessionIn(after, codexFacts(1).key)?.attention.newReply).toBe(true)
    expect(sessionIn(after, codexFacts(2).key)).toEqual(sessionIn(before, codexFacts(2).key))
    expect(sessionIn(after, claudeFacts(3).key)).toEqual(sessionIn(before, claudeFacts(3).key))
  })

  it('keeps the file watches in step with the source: new rollouts gain one, dropped ones lose it', async () => {
    codex.watched = [rollout(1)]
    await started()
    codex.watched = [rollout(1), rollout(2)]
    theWatcher().emit('codex', [rollout(2)])
    await settle()
    expect(theWatcher().files.codex).toEqual([rollout(1), rollout(2)])

    codex.watched = [rollout(2)]
    theWatcher().emit('codex', [rollout(1)])
    await settle()
    expect(theWatcher().files.codex).toEqual([rollout(2)])
  })

  it('keeps the last facts when a read fails without the source saying why', async () => {
    codex.facts = [codexFacts(1)]
    await started()
    await settle()
    codex.refresh.mockRejectedValueOnce(new Error('unexpected'))
    theWatcher().emit('codex', [rollout(1)])
    await settle()
    expect(latest().sessions.map((session) => session.key.id)).toEqual([id(1)])
  })
})

describe('one tool failing', () => {
  it('keeps the other tool working when a source reports no access', async () => {
    codex.readHealth = { state: 'no-access', lastReadAt: null }
    claude.facts = [claudeFacts(3, { turn: BUSY_CLAUDE })]
    await started()
    await settle()
    expect(latest().health).toEqual({
      codex: { state: 'no-access', lastReadAt: null },
      claude: CONNECTED
    })
    expect(latest().sessions.map((session) => session.activity.state)).toEqual(['running'])
  })

  it('keeps the other tool working when a source fails outright, and stops showing "Checking…"', async () => {
    codex.catalog.mockRejectedValueOnce(new Error('unexpected'))
    claude.facts = [claudeFacts(3)]
    await started()
    await settle()
    expect(latest().health).toEqual({
      codex: { state: 'no-access', lastReadAt: null },
      claude: CONNECTED
    })
    expect(latest().sessions).toHaveLength(1)
  })

  it('shows every session of a tool in an unsupported format as Unknown, with no new reply', async () => {
    claude.readHealth = { state: 'unsupported', toolVersion: '9.0.0' }
    claude.facts = [claudeFacts(3, { turn: BUSY_CLAUDE, lastReply: reply(id(0x103), NOW) })]
    codex.facts = [codexFacts(1, { lastReply: reply(id(0x101), NOW) })]
    await started()
    await settle()
    const snapshot = latest()
    expect(sessionIn(snapshot, claudeFacts(3).key)).toMatchObject({
      activity: { state: 'unknown', reason: 'unsupported' },
      attention: { waiting: false, newReply: false, error: false },
      summary: { title: 'Synthetic session' }
    })
    expect(sessionIn(snapshot, codexFacts(1).key)?.attention.newReply).toBe(true)
  })
})

describe('reconcile', () => {
  it('watches missing folders again and reads both tools again', async () => {
    const running = await started()
    log = []
    await running.reconcile()
    expect(log).toEqual([
      'watchFolders',
      'codex:catalog',
      'claude:catalog',
      'codex:watchFiles:0',
      'claude:watchFiles:0'
    ])
  })

  it('does nothing before start or after stop', async () => {
    const fresh = create()
    await fresh.reconcile()
    expect(codex.catalog).not.toHaveBeenCalled()
    await fresh.start()
    await fresh.stop()
    await fresh.reconcile()
    expect(codex.catalog).toHaveBeenCalledTimes(1)
  })
})

describe('the liveness timer', () => {
  it('runs no more often than every 30 s (REQ-008)', () => {
    expect(LIVENESS_INTERVAL_MS).toBeGreaterThanOrEqual(30 * SECOND)
  })

  it('re-checks only the tools with a running or waiting session, every 30 s, without reading files', async () => {
    codex.facts = [codexFacts(1, { turn: RUNNING_CODEX })]
    claude.facts = [claudeFacts(3)]
    await started()
    await settle()

    await vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL_MS - SNAPSHOT_INTERVAL_MS - 1)
    expect(codex.refresh).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(codex.refresh).toHaveBeenCalledExactlyOnceWith([])
    expect(claude.refresh).not.toHaveBeenCalled()
  })

  it('does nothing while no session runs or waits', async () => {
    codex.facts = [codexFacts(1)]
    claude.facts = [claudeFacts(3)]
    await started()
    await settle()
    const published = snapshots.length
    await vi.advanceTimersByTimeAsync(3 * LIVENESS_INTERVAL_MS)
    expect(codex.refresh).not.toHaveBeenCalled()
    expect(claude.refresh).not.toHaveBeenCalled()
    expect(snapshots).toHaveLength(published)
  })

  it('shows a Claude Code session whose process ended as Unknown', async () => {
    claude.facts = [claudeFacts(3, { turn: BUSY_CLAUDE })]
    await started()
    await settle()
    claude.facts = [
      claudeFacts(3, {
        turn: { kind: 'claude', registry: { status: 'busy', waitingFor: null, ownerAlive: false } }
      })
    ]
    await vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL_MS)
    expect(claude.refresh).toHaveBeenCalledWith([])
    expect(latest().sessions[0]?.activity).toEqual({ state: 'unknown', reason: 'process-ended' })
  })

  it('turns an open Codex turn Unknown once nothing was written for 30 minutes', async () => {
    // The last write was at NOW, when AgentPeek starts. The timer re-checks every 30 s.
    codex.facts = [
      codexFacts(1, {
        turn: RUNNING_CODEX,
        summary: { ...codexFacts(1).summary, lastActivityAt: NOW }
      })
    ]
    await started()
    await settle()
    expect(latest().sessions[0]?.activity).toEqual({ state: 'running' })
    await vi.advanceTimersByTimeAsync(30 * MINUTE - LIVENESS_INTERVAL_MS)
    expect(latest().sessions[0]?.activity).toEqual({ state: 'running' })
    await vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL_MS)
    expect(latest().sessions[0]?.activity).toEqual({ state: 'unknown', reason: 'quiet' })
    expect(latest().groupCounts.unknown).toBe(1)
  })
})

describe('snapshots', () => {
  it('keeps a Claude Code session’s activity while its new registry file has no status yet', async () => {
    claude.facts = [claudeFacts(3, { turn: BUSY_CLAUDE })]
    await started()
    await settle()
    claude.facts = [
      claudeFacts(3, {
        turn: { kind: 'claude', registry: { status: null, waitingFor: null, ownerAlive: true } }
      })
    ]
    theWatcher().emit('claude', ['/Users/synthetic/.claude/sessions/4242.json'])
    await settle()
    expect(claude.refresh).toHaveBeenCalled()
    expect(latest().sessions[0]?.activity).toEqual({ state: 'running' })
  })

  it('publishes a change at once, then at most one more per pause, holding the latest state', async () => {
    codex.facts = [codexFacts(1)]
    await started()
    // The start publishes twice (one per tool); after two pauses nothing is pending.
    await settle(2 * SNAPSHOT_INTERVAL_MS)
    const published = snapshots.length

    for (let n = 2; n <= 11; n++) {
      codex.facts = [...codex.facts, codexFacts(n)]
      theWatcher().emit('codex', [rollout(n)])
      await vi.advanceTimersByTimeAsync(0)
    }
    expect(snapshots).toHaveLength(published + 1)
    expect(latest().sessions).toHaveLength(2)

    await vi.advanceTimersByTimeAsync(SNAPSHOT_INTERVAL_MS)
    expect(snapshots).toHaveLength(published + 2)
    expect(latest().sessions).toHaveLength(11)

    // Nothing changed during the last pause, so nothing more is published, and no timer is left
    // but the liveness timer.
    await vi.advanceTimersByTimeAsync(SNAPSHOT_INTERVAL_MS)
    expect(snapshots).toHaveLength(published + 2)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('keeps publishing after the receiver throws', async () => {
    service = createSessionsService({
      sources: [codex.source, claude.source],
      store,
      createWatcher: (onChange) => {
        watcher = fakeWatcher(onChange)
        return watcher
      },
      onSnapshot: (snapshot) => {
        snapshots.push(snapshot)
        throw new Error('receiver failed')
      },
      fixture: false,
      now: () => Date.now()
    })
    await service.start()
    await settle(2 * SNAPSHOT_INTERVAL_MS)
    const published = snapshots.length
    codex.facts = [codexFacts(1)]
    theWatcher().emit('codex', [rollout(1)])
    await settle()
    expect(snapshots).toHaveLength(published + 1)
    expect(latest().sessions).toHaveLength(1)
  })

  it('returns the last published snapshot', async () => {
    const running = await started()
    await settle()
    expect(running.snapshot()).toBe(latest())
  })

  it('publishes when the store’s status changes, for the banner', async () => {
    await started()
    await settle(2 * SNAPSHOT_INTERVAL_MS)
    const published = snapshots.length
    store.failSaves({ kind: 'unavailable', reason: 'unwritable' })
    expect(snapshots).toHaveLength(published + 1)
    expect(latest().localState).toEqual({ kind: 'unavailable', reason: 'unwritable' })
  })

  it('carries the fixture flag', async () => {
    await started({ fixture: true })
    await settle()
    expect(latest().fixture).toBe(true)
  })
})

describe('the first-start baseline', () => {
  it('counts replies finished before a tool’s first read as read, and later ones as new', async () => {
    store = fakeStore()
    codex.facts = [codexFacts(1, { lastReply: reply(id(0x101), NOW - HOUR) })]
    await started()
    await settle()
    expect(store.setBaseline).toHaveBeenCalledWith('codex', NOW)
    expect(store.setBaseline).toHaveBeenCalledWith('claude', NOW)
    expect(latest().firstLaunch).toBe(true)
    expect(latest().needsAttention).toBe(0)

    vi.setSystemTime(NOW + MINUTE)
    codex.facts = [codexFacts(1, { lastReply: reply(id(0x102), NOW + MINUTE) })]
    theWatcher().emit('codex', [rollout(1)])
    await settle()
    expect(latest().needsAttention).toBe(1)
    expect(store.setBaseline).toHaveBeenCalledTimes(2)
  })

  it('keeps a saved baseline, so a reply that finished while AgentPeek was closed is new', async () => {
    store = fakeStore({ baselines: { codex: NOW - 2 * HOUR } })
    codex.facts = [codexFacts(1, { lastReply: reply(id(0x101), NOW - HOUR) })]
    await started()
    await settle()
    expect(store.setBaseline).not.toHaveBeenCalledWith('codex', expect.anything())
    expect(latest().firstLaunch).toBe(false)
    expect(latest().needsAttention).toBe(1)
  })

  it('counts every reply as read while a tool has never been read successfully', async () => {
    store = fakeStore()
    claude.readHealth = { state: 'no-access', lastReadAt: null }
    claude.facts = [claudeFacts(3, { lastReply: reply(id(0x103), NOW - MINUTE) })]
    await started()
    await settle()
    expect(store.setBaseline).not.toHaveBeenCalledWith('claude', expect.anything())
    expect(latest().sessions).toHaveLength(1)
    expect(latest().needsAttention).toBe(0)
  })

  it('sets no baseline for a tool it could not read, until it can', async () => {
    store = fakeStore()
    codex.readHealth = { state: 'not-installed' }
    const running = await started()
    expect(store.setBaseline).not.toHaveBeenCalledWith('codex', expect.anything())

    vi.setSystemTime(NOW + HOUR)
    codex.readHealth = CONNECTED
    codex.facts = [codexFacts(1, { lastReply: reply(id(0x101), NOW + 30 * MINUTE) })]
    await running.reconcile()
    await settle()
    expect(store.setBaseline).toHaveBeenCalledWith('codex', NOW + HOUR)
    expect(latest().needsAttention).toBe(0)
  })
})

describe('actions', () => {
  const CODEX_KEY = codexFacts(1).key

  it('pins and unpins a listed session, and publishes it', async () => {
    codex.facts = [codexFacts(1)]
    const running = await started()
    await settle()
    expect(running.setPinned(CODEX_KEY, true)).toBe(true)
    expect(store.localState(CODEX_KEY).pinned).toBe(true)
    await settle()
    expect(latest().sessions[0]?.pinned).toBe(true)
    expect(latest().groupCounts.pinned).toBe(1)

    expect(running.setPinned(CODEX_KEY, false)).toBe(true)
    await settle()
    expect(latest().sessions[0]?.pinned).toBe(false)
  })

  it('marks a new reply as seen, and an error as acknowledged', async () => {
    codex.facts = [codexFacts(1, { lastReply: reply(id(0x101), NOW) })]
    const running = await started()
    await settle()
    expect(latest().needsAttention).toBe(1)
    expect(running.markRead(CODEX_KEY)).toBe(true)
    expect(store.localState(CODEX_KEY)).toEqual({ ...EMPTY_LOCAL_STATE, seenCursor: id(0x101) })
    await settle()
    expect(latest().needsAttention).toBe(0)

    codex.facts = [
      codexFacts(1, {
        lastReply: reply(id(0x102), NOW, { isError: true, errorCode: 'server_overloaded' })
      })
    ]
    theWatcher().emit('codex', [rollout(1)])
    await settle()
    expect(latest().sessions[0]?.attention.error).toBe(true)
    expect(running.markRead(CODEX_KEY)).toBe(true)
    expect(store.localState(CODEX_KEY)).toEqual({
      ...EMPTY_LOCAL_STATE,
      seenCursor: id(0x101),
      acknowledgedErrorCursor: id(0x102)
    })
    await settle()
    expect(latest().needsAttention).toBe(0)
  })

  it('marks the reply the user saw, not one that arrived since the last snapshot', async () => {
    codex.facts = [codexFacts(1, { lastReply: reply(id(0x101), NOW) })]
    const running = await started()
    await vi.advanceTimersByTimeAsync(0)
    // A newer reply is read during the publish pause, so it is not shown yet.
    codex.facts = [codexFacts(1, { lastReply: reply(id(0x102), NOW) })]
    theWatcher().emit('codex', [rollout(1)])
    await vi.advanceTimersByTimeAsync(0)
    expect(running.markRead(CODEX_KEY)).toBe(true)
    expect(store.localState(CODEX_KEY).seenCursor).toBe(id(0x101))
    await settle()
    expect(latest().sessions[0]?.attention.newReply).toBe(true)
  })

  it('refuses a session that is not listed', async () => {
    const running = await started()
    expect(running.setPinned({ tool: 'codex', id: id(9) }, true)).toBe(false)
    expect(running.markRead({ tool: 'claude', id: id(9) })).toBe(false)
    expect(store.setLocalState).not.toHaveBeenCalled()
  })

  it('fails quietly for a session ID the store cannot keep, and keeps working', async () => {
    const odd = 'an id with spaces'
    claude.facts = [claudeFacts(3, { key: { tool: 'claude', id: odd } })]
    codex.facts = [codexFacts(1)]
    const running = await started()
    await settle()
    expect(running.setPinned({ tool: 'claude', id: odd }, true)).toBe(false)
    expect(running.markRead({ tool: 'claude', id: odd })).toBe(false)
    expect(running.setPinned(CODEX_KEY, true)).toBe(true)
    await settle()
    expect(sessionIn(latest(), { tool: 'claude', id: odd })?.pinned).toBe(false)
    expect(sessionIn(latest(), CODEX_KEY)?.pinned).toBe(true)
  })

  it('keeps pins in the store while it cannot save, and shows that it cannot', async () => {
    store = fakeStore({ status: { kind: 'unavailable', reason: 'newer-version' } })
    codex.facts = [codexFacts(1)]
    const running = await started()
    await settle()
    expect(running.setPinned(CODEX_KEY, true)).toBe(true)
    await settle()
    expect(latest().sessions[0]?.pinned).toBe(true)
    expect(latest().localState).toEqual({ kind: 'unavailable', reason: 'newer-version' })
  })
})

describe('recentMessages', () => {
  it('asks the session’s own source', async () => {
    const messages: RecentMessages = { kind: 'messages', messages: [], hasOlder: false }
    claude.recentMessages.mockResolvedValueOnce(messages)
    const running = await started()
    const key = claudeFacts(3).key
    await expect(running.recentMessages(key, 20)).resolves.toBe(messages)
    expect(claude.recentMessages).toHaveBeenCalledWith(key, 20)
    expect(codex.recentMessages).not.toHaveBeenCalled()
  })

  it('finds nothing for a tool it does not know', async () => {
    const running = await started()
    const key = { tool: 'other', id: id(1) } as unknown as SessionKey
    await expect(running.recentMessages(key, 20)).resolves.toEqual({ kind: 'not-found' })
  })
})

describe('stop', () => {
  it('stops the watcher and every timer, saves, and publishes nothing afterwards', async () => {
    codex.facts = [codexFacts(1, { turn: RUNNING_CODEX })]
    const running = await started()
    await settle()

    // A read is still running when stop is called.
    let finish: (facts: SessionFacts[]) => void = () => undefined
    codex.refresh.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    theWatcher().emit('codex', [rollout(1)])
    codex.facts = [codexFacts(1), codexFacts(2)]
    theWatcher().emit('codex', [rollout(2)])
    const published = snapshots.length
    log = []

    await running.stop()
    expect(log).toEqual(['watcher:close', 'store:flush'])
    expect(vi.getTimerCount()).toBe(0)

    finish([codexFacts(1)])
    await vi.advanceTimersByTimeAsync(10 * LIVENESS_INTERVAL_MS)
    expect(snapshots).toHaveLength(published)
    expect(log).toEqual(['watcher:close', 'store:flush'])
    expect(running.setPinned(codexFacts(1).key, true)).toBe(false)
    expect(running.markRead(codexFacts(1).key)).toBe(false)
    store.failSaves({ kind: 'unavailable', reason: 'unwritable' })
    expect(snapshots).toHaveLength(published)
  })

  it('does not wait for a save that hangs', async () => {
    store.flush.mockImplementationOnce(() => new Promise(() => undefined))
    const running = await started()
    let done = false
    void running.stop().then(() => {
      done = true
    })
    await vi.advanceTimersByTimeAsync(STOP_SAVE_LIMIT_MS - 1)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(done).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('starts no new read after stop', async () => {
    const running = await started()
    await running.stop()
    codex.catalog.mockClear()
    codex.refresh.mockClear()
    claude.catalog.mockClear()

    await running.start()
    await running.reconcile()
    theWatcher().emitLate('codex', [rollout(1)])
    await expect(running.recentMessages(codexFacts(1).key, 20)).resolves.toEqual({
      kind: 'not-found'
    })
    await vi.advanceTimersByTimeAsync(LIVENESS_INTERVAL_MS)
    expect(codex.catalog).not.toHaveBeenCalled()
    expect(claude.catalog).not.toHaveBeenCalled()
    expect(codex.refresh).not.toHaveBeenCalled()
    expect(codex.recentMessages).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('starts no read when stop comes while the folder watches start', async () => {
    let foldersRunning = (): void => undefined
    const running = create()
    theWatcher().watchFolders = () =>
      new Promise((resolve) => {
        foldersRunning = resolve
      })
    const starting = running.start()
    await vi.advanceTimersByTimeAsync(0)
    await running.stop()
    foldersRunning()
    await starting
    expect(codex.catalog).not.toHaveBeenCalled()
    expect(claude.catalog).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not start once stopped first', async () => {
    const fresh = create()
    await fresh.stop()
    await fresh.start()
    expect(codex.catalog).not.toHaveBeenCalled()
    expect(log).toEqual(['watcher:close', 'store:flush'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops once, however often it is called', async () => {
    const running = await started()
    const first = running.stop()
    expect(running.stop()).toBe(first)
    await first
    expect(store.flush).toHaveBeenCalledTimes(1)
  })
})

describe('source monitoring switches', () => {
  it('blocks disabled/missing skill reads and discards in-flight content across source epochs', async () => {
    codex.facts = [codexFacts(1)]
    let finish!: (value: SkillContent) => void
    const readSkill = vi.fn(
      () =>
        new Promise<SkillContent>((resolve) => {
          finish = resolve
        })
    )
    codex.source.getSkill = readSkill
    const running = await started()
    await settle()
    const request = { at: NOW, name: 'pr', path: '/Users/synthetic/.agents/skills/pr/SKILL.md' }
    const key = codex.facts[0]!.key
    expect(await running.getSkill({ tool: 'codex', id: id(99) }, request)).toEqual({
      kind: 'unavailable',
      reason: 'not-found'
    })
    expect(readSkill).not.toHaveBeenCalled()
    const pending = running.getSkill(key, request)
    expect(readSkill).toHaveBeenCalledTimes(1)
    await running.setSourceEnabled('codex', false)
    expect(await running.getSkill(key, request)).toEqual({
      kind: 'unavailable',
      reason: 'not-found'
    })
    expect(readSkill).toHaveBeenCalledTimes(1)
    await running.setSourceEnabled('codex', true)
    await settle()
    finish({
      kind: 'skill',
      source: 'local',
      text: 'Synthetic transient content',
      description: null,
      truncated: false
    })
    expect(await pending).toEqual({ kind: 'unavailable', reason: 'not-found' })
    expect(JSON.stringify(running.snapshot())).not.toContain('Synthetic transient content')
  })
  it('skips saved-off sources at startup and every later refresh', async () => {
    const running = await started({ enabledSources: { codex: false, claude: true } })
    await settle()
    expect(running.snapshot().health.codex).toEqual({ state: 'off' })
    expect(codex.catalog).not.toHaveBeenCalled()
    theWatcher().emit('codex', [rollout(1)])
    await running.reconcile()
    await settle(LIVENESS_INTERVAL_MS)
    expect(codex.catalog).not.toHaveBeenCalled()
    expect(codex.refresh).not.toHaveBeenCalled()
    await expect(running.recentMessages({ tool: 'codex', id: id(1) }, 20)).resolves.toEqual({
      kind: 'not-found'
    })
    expect(codex.recentMessages).not.toHaveBeenCalled()
    expect(claude.catalog).toHaveBeenCalled()
  })
  it('removes sessions and counts while off, then restores pins and read markers after rediscovery', async () => {
    codex.facts = [codexFacts(1, { lastReply: reply('reply-one', NOW) })]
    const running = await started()
    await settle()
    const key = codex.facts[0]!.key
    expect(running.setPinned(key, true)).toBe(true)
    expect(running.markRead(key)).toBe(true)
    await running.setSourceEnabled('codex', false)
    expect(running.snapshot().sessions).toEqual([])
    expect(running.snapshot().needsAttention).toBe(0)
    expect(theWatcher().files.codex).toEqual([])
    expect(running.setPinned(key, false)).toBe(false)
    await running.setSourceEnabled('codex', true)
    await settle()
    expect(running.snapshot().sessions[0]).toMatchObject({
      key,
      pinned: true,
      attention: { newReply: false }
    })
    expect(codex.catalog).toHaveBeenCalledTimes(3)
  })
  it('discards late catalog and message results after switching off and on', async () => {
    codex.facts = [codexFacts(1)]
    const running = await started()
    await settle()
    let finishCatalog!: (facts: SessionFacts[]) => void
    let finishMessages!: (result: RecentMessages) => void
    codex.catalog.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishCatalog = resolve
        })
    )
    codex.recentMessages.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishMessages = resolve
        })
    )
    const messages = running.recentMessages(codex.facts[0]!.key, 20)
    const refresh = running.reconcile()
    await Promise.resolve()
    await running.setSourceEnabled('codex', false)
    await running.setSourceEnabled('codex', true)
    finishCatalog([codexFacts(2)])
    finishMessages({ kind: 'messages', messages: [], hasOlder: false })
    await refresh
    await settle()
    expect(running.snapshot().sessions.map((s) => s.key.id)).toEqual([id(1)])
    await expect(messages).resolves.toEqual({ kind: 'not-found' })
  })
})

describe('session range', () => {
  const DAY = 24 * HOUR

  it('lists the default range, then reports when a source left out older sessions', async () => {
    const running = await started()
    await settle()
    expect(running.listingRange()).toEqual({ windowMs: 7 * DAY, maxPerTool: 50 })
    expect(latest().range).toEqual({
      savedDays: 7,
      savedMaxPerTool: 50,
      loadedDays: 7,
      loadedMaxPerTool: 50,
      olderAvailable: false
    })
    codex.older = true
    await running.reconcile()
    await settle()
    expect(latest().range.olderAvailable).toBe(true)
  })

  it('doubles the range for Load Older, lists again, and resets on a saved change', async () => {
    const running = await started()
    await settle()
    log = []
    await running.loadOlder()
    await settle()
    expect(log).toEqual(expect.arrayContaining(['codex:catalog', 'claude:catalog']))
    expect(running.listingRange()).toEqual({ windowMs: 14 * DAY, maxPerTool: 100 })
    expect(latest().range).toMatchObject({ loadedDays: 14, loadedMaxPerTool: 100, savedDays: 7 })

    log = []
    await running.setSessionRange({ days: 30, maxPerTool: 200 })
    await settle()
    expect(log).toEqual(expect.arrayContaining(['codex:catalog', 'claude:catalog']))
    expect(running.listingRange()).toEqual({ windowMs: 30 * DAY, maxPerTool: 200 })
    expect(latest().range).toMatchObject({
      savedDays: 30,
      savedMaxPerTool: 200,
      loadedDays: 30,
      loadedMaxPerTool: 200
    })
  })

  it('stops offering Load Older after the last doubling', async () => {
    codex.older = true
    const running = await started()
    for (let n = 0; n < MAX_RANGE_DOUBLINGS; n++) await running.loadOlder()
    await settle()
    expect(latest().range).toMatchObject({ loadedDays: 7 * 2 ** MAX_RANGE_DOUBLINGS })
    expect(latest().range.olderAvailable).toBe(false)
    log = []
    await running.loadOlder()
    expect(log).toEqual([])
  })

  it('counts replies older than the forgotten read markers as read', async () => {
    store = fakeStore({ baselines: { codex: NOW - 200 * DAY, claude: NOW - 200 * DAY } })
    codex.facts = [
      codexFacts(1, { lastReply: reply('old', NOW - 100 * DAY) }),
      codexFacts(2, { lastReply: reply('recent', NOW - 10 * DAY) })
    ]
    await started()
    await settle()
    expect(sessionIn(latest(), codexFacts(1).key)?.attention.newReply).toBe(false)
    expect(sessionIn(latest(), codexFacts(2).key)?.attention.newReply).toBe(true)
  })
})
