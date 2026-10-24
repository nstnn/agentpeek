import { establishBaseline, markRead as markReplyRead } from '../../core/attention'
import { deriveSession, factsUnderHealth } from '../../core/derive-session'
import type { ToolHealth } from '../../core/health'
import {
  type Session,
  type SessionActivity,
  type SessionFacts,
  type SessionKey,
  type SessionLocalState,
  sessionKeyToString
} from '../../core/session'
import { createSnapshot, type SessionsSnapshot } from '../../core/snapshot'
import { AGENT_TOOLS, type AgentTool } from '../../core/tools'
import type { ChangeListener, SessionWatcher } from './file-watcher'
import type { RecentMessages, SessionSource } from './session-source'
import type { StateStore } from './state-store'
import { DEFAULT_SOURCES, type SourcePreferences } from '../../shared/preferences'
import type { SkillContent, SkillRequest } from '../../core/skills'

// The sessions service (TASK-010). It runs while the window is open and ties together:
// - both sources, which read the tools' files and report facts;
// - the watcher, whose changed paths go to the right source (only those files are read again);
// - a timer that re-checks processes and time rules for running and waiting sessions;
// - the local state store, for pins, read markers, and each tool's first-start baseline.
// From all of that it derives sessions with the rules in src/core and publishes snapshots. The
// renderer only ever sees those snapshots and the results of `recentMessages`. Nothing here reads a
// file itself, and nothing is logged.

/** How often running and waiting sessions are re-checked (REQ-008: at least 30 s). */
export const LIVENESS_INTERVAL_MS = 30 * 1000

/** Snapshots are published at most this often, so a busy turn sends a few per second at most. */
export const SNAPSHOT_INTERVAL_MS = 250

/**
 * How long `stop` waits for the store to save. A save can hang on something other than a regular
 * file in the temporary file's place (TASK-009), and quitting must not wait for it.
 */
export const STOP_SAVE_LIMIT_MS = 1000

export interface SessionsServiceOptions {
  /** One source per tool. */
  sources: readonly SessionSource[]
  store: StateStore
  /** Creates the watcher, given where to send changed paths. */
  createWatcher: (onChange: ChangeListener) => SessionWatcher
  /** Receives each new snapshot. If it throws, the next snapshot is still sent. */
  onSnapshot: (snapshot: SessionsSnapshot) => void
  /** True when the sources read synthetic data (`AGENTPEEK_HOME`). */
  fixture: boolean
  enabledSources?: SourcePreferences
  /** The clock, in epoch milliseconds. */
  now?: () => number
}

export interface SessionsService {
  /** Enables/disables this app's monitoring only; disabled sources perform no new reads. */
  setSourceEnabled(this: void, tool: AgentTool, enabled: boolean): Promise<void>
  /** Reads enabled tools, then starts the watcher and the timer. Call it once; after `stop` it does nothing. */
  start(): Promise<void>
  /**
   * Reads enabled tools again: catalogs, registry, and the Codex rollout sweep. The main process calls
   * it on window focus, on wake, and for View > Reload Sessions.
   */
  reconcile(): Promise<void>
  /** The last snapshot published, or the first one ("Checking…") before anything was read. */
  snapshot(): SessionsSnapshot
  /**
   * A listed session's recent messages, read for the detail. Never part of a snapshot. After `stop`
   * it reads nothing and finds nothing.
   */
  recentMessages(key: SessionKey, limit: number): Promise<RecentMessages>
  getSkill(key: SessionKey, request: SkillRequest): Promise<SkillContent>
  /** Pins or unpins a listed session. False when it is not listed or cannot be stored. */
  setPinned(key: SessionKey, pinned: boolean): boolean
  /**
   * Marks a listed session's latest reply as seen, or its latest error as acknowledged (Mark Read,
   * or its detail shown in the focused window). False when it is not listed or cannot be stored.
   */
  markRead(key: SessionKey): boolean
  /**
   * Stops the watcher and the timer, then saves. Nothing is published, and no new read starts,
   * afterwards; a read already queued in a source still finishes, with no effect.
   */
  stop(): Promise<void>
}

/** What the service knows about one tool. */
interface ToolState {
  enabled: boolean
  epoch: number
  source: SessionSource
  /** The facts from the last read that finished. */
  facts: readonly SessionFacts[]
  /** Whether a reconcile has finished, successfully or not. */
  read: boolean
}

export function createSessionsService(options: SessionsServiceOptions): SessionsService {
  const { store } = options
  const now = options.now ?? Date.now
  const tools = new Map<AgentTool, ToolState>()
  for (const tool of AGENT_TOOLS) {
    const source = options.sources.find((candidate) => candidate.tool === tool)
    if (source === undefined) throw new Error(`No source for ${tool}.`)
    tools.set(tool, {
      source,
      facts: [],
      read: false,
      enabled: (options.enabledSources ?? DEFAULT_SOURCES)[tool],
      epoch: 0
    })
  }
  // AgentPeek had read neither tool before this launch: the "First launch" strip. When the saved
  // state could not be loaded, no baseline is known on any launch; the "Local state unavailable"
  // banner explains that instead, so the strip does not show at every launch.
  const firstLaunch =
    store.status().kind === 'available' &&
    AGENT_TOOLS.every((tool) => store.baseline(tool) === undefined)

  let started = false
  let stopped: Promise<void> | null = null
  let livenessTimer: ReturnType<typeof setInterval> | null = null
  /** The pause after a publish; changes during it are published when it ends. */
  let publishPause: ReturnType<typeof setTimeout> | null = null
  let changedDuringPause = false
  let previousActivity = new Map<string, SessionActivity>()
  let current = build()
  let listed = sessionsByKey(current)
  const watcher = options.createWatcher((tool, paths) => {
    // The real watcher reports nothing after `close`; this also keeps a late report from reading.
    if (stopped === null) void update(tool, (source) => source.refresh(paths))
  })

  /**
   * Runs one read of a tool's source and takes in its facts. The source queues its calls, so reads
   * of one tool finish in the order they were asked for, and the last one wins.
   */
  async function update(
    tool: AgentTool,
    read: (source: SessionSource) => Promise<SessionFacts[]>,
    isReconcile = false
  ): Promise<void> {
    // A stop that came while this read waited (for the folder watches, say) cancels it.
    if (stopped !== null) return
    const state = toolState(tool)
    if (!state.enabled) return
    const epoch = state.epoch
    let facts: SessionFacts[] | null = null
    try {
      facts = await read(state.source)
    } catch {
      // A source reports what went wrong in its health. Anything else keeps the last facts.
    }
    if (stopped !== null || !state.enabled || epoch !== state.epoch) return
    if (facts !== null) state.facts = facts
    if (isReconcile) state.read = true
    noteFirstRead(tool, state.source.health())
    watcher.watchFiles(tool, state.source.watchedFiles())
    changed()
  }

  /**
   * The first-start baseline (REQ-004): the first time a tool is read successfully, every reply it
   * finished up to now counts as read. The store keeps it for later launches.
   */
  function noteFirstRead(tool: AgentTool, health: ToolHealth): void {
    const saved = store.baseline(tool)
    if (saved !== undefined || (health.state !== 'connected' && health.state !== 'unsupported')) {
      return
    }
    try {
      store.setBaseline(tool, establishBaseline(saved, now()))
    } catch {
      // A clock the store cannot save. Replies keep counting as read until the next try.
    }
  }

  function toolState(tool: AgentTool): ToolState {
    const state = tools.get(tool)
    if (state === undefined) throw new Error(`No source for ${tool}.`)
    return state
  }

  function healthOf(state: ToolState): ToolHealth {
    if (!state.enabled) return { state: 'off' }
    if (!state.read) return { state: 'checking' }
    const health = state.source.health()
    // A read that failed without the source saying why: never leave the tool at "Checking…".
    return state.read && health.state === 'checking'
      ? { state: 'no-access', lastReadAt: null }
      : health
  }

  function build(): SessionsSnapshot {
    const at = now()
    const sessions: Session[] = []
    const health = {} as Record<AgentTool, ToolHealth>
    for (const [tool, state] of tools) {
      const toolHealth = healthOf(state)
      health[tool] = toolHealth
      if (!state.enabled) continue
      // Until a tool has been read once, every reply it finished counts as read.
      const baselineAt = store.baseline(tool) ?? at
      for (const facts of state.facts) {
        sessions.push(
          deriveSession({
            facts: factsUnderHealth(facts, toolHealth),
            local: store.localState(facts.key),
            baselineAt,
            previousActivity: previousActivity.get(sessionKeyToString(facts.key)),
            now: at
          })
        )
      }
    }
    previousActivity = new Map(
      sessions.map((session) => [sessionKeyToString(session.key), session.activity])
    )
    // Keeps the stored pins and markers of listed sessions from being forgotten after 90 days.
    store.noteListed(sessions.map((session) => session.key))
    return createSnapshot({
      sessions,
      health,
      localState: store.status(),
      firstLaunch,
      fixture: options.fixture,
      takenAt: at
    })
  }

  /** Publishes a snapshot now, or when the pause after the last one ends. */
  function changed(): void {
    if (stopped !== null) return
    if (publishPause !== null) {
      changedDuringPause = true
      return
    }
    publish()
  }

  function publish(): void {
    current = build()
    listed = sessionsByKey(current)
    changedDuringPause = false
    publishPause = setTimeout(() => {
      publishPause = null
      if (changedDuringPause) publish()
    }, SNAPSHOT_INTERVAL_MS)
    try {
      options.onSnapshot(current)
    } catch {
      // A receiver that fails must not stop the snapshots that follow.
    }
  }

  /** Re-checks the tools that have a running or waiting session, without reading any file. */
  function checkLiveness(): void {
    for (const tool of AGENT_TOOLS) {
      const open = current.sessions.some(
        (session) => session.key.tool === tool && isRunningOrWaiting(session.activity)
      )
      if (open) void update(tool, (source) => source.refresh([]))
    }
  }

  async function reconcileAll(): Promise<void> {
    // The folder watches start before the reads, so no change in between is missed.
    await watcher.watchFolders(enabledTools())
    await Promise.all(AGENT_TOOLS.map((tool) => update(tool, (source) => source.catalog(), true)))
  }

  function enabledTools(): AgentTool[] {
    return AGENT_TOOLS.filter((tool) => toolState(tool).enabled)
  }

  /** Saves a session's new local state. False when the store refuses its ID or cursor. */
  function saveLocalState(key: SessionKey, local: SessionLocalState): boolean {
    try {
      store.setLocalState(key, local)
    } catch (error) {
      // An ID or cursor that does not look like one (TASK-009): nothing is stored or logged.
      if (error instanceof TypeError) return false
      throw error
    }
    changed()
    return true
  }

  /** The listed session with this key, from the snapshot the user sees. */
  function listedSession(key: SessionKey): Session | undefined {
    if (stopped !== null || !toolState(key.tool).enabled) return undefined
    return listed.get(sessionKeyToString(key))
  }

  return {
    async setSourceEnabled(tool, enabled) {
      if (stopped !== null) return
      const state = toolState(tool)
      if (state.enabled === enabled) return
      state.enabled = enabled
      state.epoch++
      state.facts = []
      state.read = false
      watcher.watchFiles(tool, [])
      // Publish the choice immediately, before any discovery can finish.
      if (publishPause !== null) clearTimeout(publishPause)
      publishPause = null
      publish()
      if (!started) return
      await watcher.watchFolders(enabledTools())
      if (enabled) await update(tool, (source) => source.catalog(), true)
    },
    async start() {
      // Once stopped, the service never starts again: the window is closing.
      if (started || stopped !== null) return
      started = true
      store.setStatusListener(changed)
      await reconcileAll()
      if (stopped === null) livenessTimer = setInterval(checkLiveness, LIVENESS_INTERVAL_MS)
    },

    async reconcile() {
      if (!started || stopped !== null) return
      await reconcileAll()
    },

    snapshot: () => current,

    async recentMessages(key, limit) {
      const state = tools.get(key.tool)
      if (state === undefined || stopped !== null || !state.enabled) return { kind: 'not-found' }
      const epoch = state.epoch
      const result = await state.source.recentMessages(key, limit)
      return stopped !== null || !state.enabled || state.epoch !== epoch
        ? { kind: 'not-found' }
        : result
    },

    async getSkill(key, request) {
      const state = tools.get(key.tool)
      if (!state?.source.getSkill || !listedSession(key))
        return { kind: 'unavailable', reason: 'not-found' }
      const epoch = state.epoch
      const result = await state.source.getSkill(key, request)
      return stopped !== null || !state.enabled || state.epoch !== epoch || !listedSession(key)
        ? { kind: 'unavailable', reason: 'not-found' }
        : result
    },

    setPinned(key, pinned) {
      const session = listedSession(key)
      if (session === undefined) return false
      return saveLocalState(session.key, { ...store.localState(session.key), pinned })
    },

    markRead(key) {
      const session = listedSession(key)
      if (session === undefined) return false
      // The reply the user saw: the one in the published snapshot.
      return saveLocalState(
        session.key,
        markReplyRead(store.localState(session.key), session.lastReply)
      )
    },

    stop() {
      stopped ??= (async () => {
        if (livenessTimer !== null) clearInterval(livenessTimer)
        if (publishPause !== null) clearTimeout(publishPause)
        livenessTimer = null
        publishPause = null
        watcher.close()
        store.setStatusListener(null)
        await withinTime(store.flush(), STOP_SAVE_LIMIT_MS)
      })()
      return stopped
    }
  }
}

function sessionsByKey(snapshot: SessionsSnapshot): Map<string, Session> {
  return new Map(snapshot.sessions.map((session) => [sessionKeyToString(session.key), session]))
}

function isRunningOrWaiting(activity: SessionActivity): boolean {
  return activity.state === 'running' || activity.state === 'waiting'
}

/** Waits for `task`, but no longer than `limitMs`. A failure counts as done. */
async function withinTime(task: Promise<unknown>, limitMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const limit = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, limitMs)
  })
  try {
    await Promise.race([task.catch(() => undefined), limit])
  } finally {
    clearTimeout(timer)
  }
}
