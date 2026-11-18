import { lstat } from 'node:fs/promises'
import { type CodexFileStatus, codexSessionFacts } from '../../core/codex/facts'
import { codexMessages } from '../../core/codex/messages'
import {
  type CodexRecord,
  type CodexThreadMeta,
  parseIndexLine,
  parseRecord,
  parseSessionMeta,
  type SessionMetaResult
} from '../../core/codex/records'
import {
  type CodexTurnState,
  EMPTY_CODEX_TURN_STATE,
  foldCodexRecords
} from '../../core/codex/turn-state'
import type { ToolHealth } from '../../core/health'
import type { SessionFacts, SessionKey } from '../../core/session'
import type { SkillContent, SkillRequest } from '../../core/skills'
import { readRequestedSkill } from './skill-reader'
import { type AccessGate, createAccessGate } from './access'
import { isCodexAppRunning } from './codex-app'
import { codexPaths, isRolloutPath, type RolloutFile, sweepRollouts } from './codex-files'
import { type JsonlCursor, readFirstLine, readLastLines, readNewLines } from './jsonl-reader'
import {
  DEFAULT_LISTING_RANGE,
  type ListingRange,
  type RecentMessages,
  type SessionSource
} from './session-source'
import { createQueue, isMissing } from './source-support'

// The Codex source (TASK-007). It lists the user's Codex threads and reports their facts.
// - Which threads: at each reconcile, a metadata-only sweep lists the rollouts and their
//   modification times. The newest rollouts in the listing range (7 days by default) are sorted out
//   by their first line (`session_meta`, read once per file), and the first user threads up to the
//   range's cap (50 by default) are kept. Child threads
//   (reviews, subagents) are skipped. `session_index.jsonl` gives titles only: it also has lines for
//   child threads and for threads whose rollouts were archived or compressed, so a thread with an
//   index line but no rollout is not listed.
// - Turns: a kept rollout's tail is read once, then only the lines Codex adds (from a cursor).
// - Live updates: Codex keeps a rollout open while it appends, so a folder watch misses the appends
//   (TASK-002). `watchedFiles()` names the rollouts that need their own file watch, and the service
//   passes the changed paths to `refresh`.
// Everything read here is conversation data: it is never logged or kept beyond what the facts hold.

export interface CodexSourceOptions {
  /** Saved pin IDs, exempt from recent-session limits. */
  pinnedIds?: () => readonly string[]
  /** The listing range, read at each listing. The default range when absent. */
  range?: () => ListingRange
  /** The home folder: the user's, or `AGENTPEEK_HOME` in fixture mode. */
  home: string
  fixture?: boolean
  /** The access gate for `home`. Tests pass one that records what it opens. */
  gate?: AccessGate
  /** Whether the Codex app is running. Tests and fixture mode pass their own. */
  isAppRunning?: () => Promise<boolean>
  /** The clock, in epoch milliseconds. */
  now?: () => number
}

/** A listed thread and what has been read of its rollout. */
interface TrackedRollout {
  path: string
  meta: CodexThreadMeta
  modifiedAt: number
  /** Where the next read starts, or null when the tail must be read again. */
  cursor: JsonlCursor | null
  state: CodexTurnState
  status: CodexFileStatus
}

/**
 * The tail read of a rollout, in growing steps. It stops at the first step that holds a turn event.
 * One 7-minute turn wrote 1.37 MB (TASK-002), so a long turn's `task_started` can be far back.
 * Past the last step the turn shows as Unknown ("Can't read") until its next turn event arrives.
 */
const TAIL_STEPS_BYTES = [256 * 1024, 2 * 1024 * 1024, 16 * 1024 * 1024] as const

/** The most that is read of the lines added since the cursor. More starts over from the tail. */
const NEW_LINES_MAX_BYTES = 4 * 1024 * 1024

/** The tail read for the detail's messages. */
const MESSAGES_TAIL_BYTES = 2 * 1024 * 1024

/** The tail read of `session_index.jsonl`. Older lines only cost titles. */
const INDEX_MAX_BYTES = 4 * 1024 * 1024

/** How long an app check is reused, so a burst of file events runs it once. */
const APP_CHECK_MAX_AGE_MS = 5000

/** The line limit for reads that only the byte budget limits. */
const ALL_LINES = Number.MAX_SAFE_INTEGER

/** What the first line of a rollout says, or why it was not read. */
type MetaLookup =
  | SessionMetaResult
  // The file has no complete first line yet: Codex has just created it.
  | 'not-yet'
  // The file is gone, or the gate refused it.
  | 'skip'

export function createCodexSource(options: CodexSourceOptions): SessionSource {
  const paths = codexPaths(options.home)
  const gate = options.gate ?? createAccessGate(options.home)
  const isAppRunning = options.isAppRunning ?? isCodexAppRunning
  const now = options.now ?? Date.now

  /** First lines read so far, by rollout path. They never change. */
  const metas = new Map<string, SessionMetaResult>()
  /** The listed threads, by rollout path. */
  const tracked = new Map<string, TrackedRollout>()
  /** New rollouts whose first line has not arrived; they get a file watch until it does. */
  const pending = new Set<string>()
  /** Thread titles from the index, by thread ID. */
  const titles = new Map<string, string | null>()
  let indexCursor: JsonlCursor | null = null
  let health: ToolHealth = { state: 'checking' }
  let lastReadAt: number | null = null
  let appCheck: { at: number; running: boolean } | null = null
  /** Whether the last listing left out rollouts because of the range. */
  let older = false
  const serialized = createQueue()
  const range = () => options.range?.() ?? DEFAULT_LISTING_RANGE

  async function reconcile(): Promise<SessionFacts[]> {
    const startedAt = now()
    const { windowMs, maxPerTool } = range()
    let files: RolloutFile[]
    try {
      files = await sweepRollouts(paths.sessions)
    } catch (error) {
      health = isMissing(error) ? { state: 'not-installed' } : { state: 'no-access', lastReadAt }
      tracked.clear()
      pending.clear()
      return []
    }
    forgetAbsent(new Set(files.map((file) => file.path)))

    const pins = new Set(options.pinnedIds?.() ?? [])
    const remainingPins = new Set(pins)
    const recent = files.sort((a, b) => b.modifiedAt - a.modifiedAt)
    let recentCount = 0
    const kept: TrackedRollout[] = []
    let recognized = 0
    let unrecognized = 0
    let unrecognizedVersion: string | null = null
    older = false
    for (const file of recent) {
      const recentCandidate = startedAt - file.modifiedAt <= windowMs && recentCount < maxPerTool
      if (!recentCandidate) older = true
      if (!recentCandidate && remainingPins.size === 0) break
      if (!recentCandidate && ![...remainingPins].some((id) => file.path.endsWith(`-${id}.jsonl`)))
        continue
      const meta = await threadMeta(file.path)
      if (meta === 'skip') continue
      if (meta === 'not-yet') {
        pending.add(file.path)
        continue
      }
      if (meta.kind === 'unrecognized') {
        unrecognized++
        unrecognizedVersion ??= meta.cliVersion
        continue
      }
      recognized++
      if (!meta.meta.isUserThread) continue
      const pinned = pins.has(meta.meta.id)
      remainingPins.delete(meta.meta.id)
      if (!pinned && !recentCandidate) continue
      const entry = tracked.get(file.path) ?? newEntry(file.path, meta.meta, file.modifiedAt)
      entry.modifiedAt = file.modifiedAt
      if (await readRollout(entry)) {
        kept.push(entry)
        if (!pinned) recentCount++
      }
    }
    keep(kept)
    await readIndex()
    await checkApp()

    lastReadAt = startedAt
    // Every first line is in a format AgentPeek does not know: Codex has changed its format.
    health =
      recognized === 0 && unrecognized > 0
        ? { state: 'unsupported', toolVersion: unrecognizedVersion }
        : { state: 'connected', lastReadAt: startedAt }
    return facts()
  }

  async function refresh(changedPaths: readonly string[]): Promise<SessionFacts[]> {
    let readAny = false
    for (const path of new Set(changedPaths)) {
      if (path === paths.index) {
        await readIndex()
        readAny = true
        continue
      }
      if (!isRolloutPath(paths, path)) continue
      const entry = tracked.get(path)
      if (entry === undefined) {
        await discover(path)
      } else if (!(await readRollout(entry))) {
        tracked.delete(path)
      }
      readAny = true
    }
    keep([...tracked.values()])
    await checkApp()
    if (readAny && health.state === 'connected') {
      lastReadAt = now()
      health = { state: 'connected', lastReadAt }
    }
    return facts()
  }

  /** A rollout the watcher reported that is not listed yet: a new thread, or a resumed one. */
  async function discover(path: string): Promise<void> {
    const meta = await threadMeta(path)
    if (meta === 'not-yet') {
      pending.add(path)
      return
    }
    pending.delete(path)
    if (meta === 'skip' || meta.kind === 'unrecognized' || !meta.meta.isUserThread) return
    const stats = await lstat(path).catch(() => null)
    if (stats === null) return
    const entry = newEntry(path, meta.meta, stats.mtimeMs)
    if (await readRollout(entry)) tracked.set(path, entry)
  }

  async function threadMeta(path: string): Promise<MetaLookup> {
    const cached = metas.get(path)
    if (cached !== undefined) return cached
    let result: SessionMetaResult
    try {
      const first = await readFirstLine(gate, path)
      if (first.kind === 'none') return 'not-yet'
      // A first line over the 1 MiB cap is not a `session_meta` AgentPeek can use.
      result =
        first.kind === 'line'
          ? parseSessionMeta(first.line)
          : { kind: 'unrecognized', cliVersion: null }
    } catch {
      return 'skip'
    }
    metas.set(path, result)
    return result
  }

  /** Reads what is new in a rollout. Returns false when the file is gone. */
  async function readRollout(entry: TrackedRollout): Promise<boolean> {
    try {
      if (entry.cursor !== null) {
        const added = await readNewLines(gate, entry.path, entry.cursor, {
          maxBytes: NEW_LINES_MAX_BYTES
        })
        if (added.kind === 'lines') {
          const records = parseRecords(added.lines)
          entry.cursor = added.cursor
          entry.state = foldCodexRecords(entry.state, records)
          if (records.length > 0) entry.status = 'read'
          return true
        }
        // The file was replaced, cut, rewritten, or grew too much: read its tail again.
      }
      await readTail(entry)
      return true
    } catch (error) {
      // A rollout that is gone was archived or compressed (or deleted).
      if (isMissing(error)) return false
      entry.status = 'unreadable'
      entry.cursor = null
      return true
    }
  }

  async function readTail(entry: TrackedRollout): Promise<void> {
    for (const maxBytes of TAIL_STEPS_BYTES) {
      const tail = await readLastLines(gate, entry.path, { maxLines: ALL_LINES, maxBytes })
      // The first line (`session_meta`) was checked already. If no other line has the record
      // envelope, Codex has changed how it writes records.
      const body = tail.reachedStart ? tail.lines.slice(1) : tail.lines
      const records = parseRecords(body)
      entry.cursor = tail.cursor
      entry.state = foldCodexRecords(EMPTY_CODEX_TURN_STATE, records)
      entry.status = body.length > 0 && records.length === 0 ? 'unsupported' : 'read'
      if (entry.state.lastTurnEvent !== null || tail.reachedStart) return
    }
  }

  async function readIndex(): Promise<void> {
    try {
      if (indexCursor !== null) {
        const added = await readNewLines(gate, paths.index, indexCursor, {
          maxBytes: INDEX_MAX_BYTES
        })
        if (added.kind === 'lines') {
          addTitles(added.lines)
          indexCursor = added.cursor
          return
        }
      }
      const tail = await readLastLines(gate, paths.index, {
        maxLines: ALL_LINES,
        maxBytes: INDEX_MAX_BYTES
      })
      titles.clear()
      addTitles(tail.lines)
      indexCursor = tail.cursor
    } catch (error) {
      // A missing or unreadable index only costs the titles.
      indexCursor = null
      if (isMissing(error)) titles.clear()
    }
  }

  function addTitles(lines: readonly string[]): void {
    for (const line of lines) {
      const entry = parseIndexLine(line)
      // Lines are appended, so a later line for the same thread wins.
      if (entry !== null) titles.set(entry.id, entry.title)
    }
  }

  /** Checks the Codex app only when a listed thread has an open turn: only then does it matter. */
  async function checkApp(): Promise<void> {
    const openTurn = [...tracked.values()].some((entry) => entry.state.lastTurnEvent === 'started')
    if (!openTurn) return
    const at = now()
    if (appCheck !== null && at - appCheck.at < APP_CHECK_MAX_AGE_MS) return
    const running = await isAppRunning().catch(() => true)
    appCheck = { at, running }
  }

  /**
   * Keeps the threads to list: active within the range, newest first, one rollout per thread, at
   * most the range's cap. The rest are no longer tracked.
   */
  function keep(entries: readonly TrackedRollout[]): void {
    const { windowMs, maxPerTool } = range()
    const cutoff = now() - windowMs
    const ids = new Set<string>()
    tracked.clear()
    const pins = new Set(options.pinnedIds?.() ?? [])
    let recentCount = 0
    for (const entry of [...entries].sort(newestFirst)) {
      const pinned = pins.has(entry.meta.id)
      if (ids.has(entry.meta.id)) continue
      if (!pinned && (recentCount >= maxPerTool || lastActivityAt(entry) < cutoff)) {
        older = true
        continue
      }
      if (!pinned) recentCount++
      ids.add(entry.meta.id)
      tracked.set(entry.path, entry)
    }
  }

  function forgetAbsent(present: ReadonlySet<string>): void {
    for (const path of metas.keys()) if (!present.has(path)) metas.delete(path)
    for (const path of pending) if (!present.has(path)) pending.delete(path)
  }

  function facts(): SessionFacts[] {
    const appRunning = appCheck?.running ?? true
    return [...tracked.values()].sort(newestFirst).map((entry) =>
      codexSessionFacts({
        meta: entry.meta,
        title: titles.get(entry.meta.id) ?? null,
        state: entry.state,
        fileStatus: entry.status,
        fileModifiedAt: entry.modifiedAt,
        appRunning
      })
    )
  }

  async function recentMessages(key: SessionKey, limit: number): Promise<RecentMessages> {
    const entry =
      key.tool === 'codex'
        ? [...tracked.values()].find((candidate) => candidate.meta.id === key.id)
        : undefined
    if (entry === undefined) return { kind: 'not-found' }
    try {
      const tail = await readLastLines(gate, entry.path, {
        maxLines: ALL_LINES,
        maxBytes: MESSAGES_TAIL_BYTES
      })
      const records = parseRecords(tail.lines, { includeToolInputs: true })
      const messages = codexMessages(records)
      const lastTurn = records.findLast(
        (record) =>
          record.kind === 'turn-completed' ||
          record.kind === 'turn-started' ||
          record.kind === 'turn-aborted'
      )
      const error =
        lastTurn?.kind === 'turn-completed' && lastTurn.outcome?.isError && lastTurn.errorMessage
          ? { cursor: lastTurn.outcome.turnId, message: lastTurn.errorMessage }
          : undefined
      const count = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0
      return {
        kind: 'messages',
        messages: messages.slice(Math.max(0, messages.length - count)),
        hasOlder: messages.length > count || !tail.reachedStart,
        ...(error ? { error } : {})
      }
    } catch {
      return { kind: 'unreadable' }
    }
  }

  return {
    tool: 'codex',
    catalog: () => serialized(reconcile),
    refresh: (changedPaths) => serialized(() => refresh(changedPaths)),
    recentMessages,
    async getSkill(key: SessionKey, request: SkillRequest): Promise<SkillContent> {
      const entry =
        key.tool === 'codex'
          ? [...tracked.values()].find((item) => item.meta.id === key.id)
          : undefined
      if (!entry) return { kind: 'unavailable', reason: 'not-found' }
      try {
        const tail = await readLastLines(gate, entry.path, {
          maxLines: ALL_LINES,
          maxBytes: MESSAGES_TAIL_BYTES
        })
        return await readRequestedSkill({
          lines: tail.lines,
          request,
          home: options.home,
          workspace: entry.meta.cwd,
          fixture: options.fixture === true
        })
      } catch {
        return { kind: 'unavailable', reason: 'unreadable' }
      }
    },
    health: () => health,
    watchedFiles: () => [...tracked.keys(), ...pending],
    olderAvailable: () => older
  }
}

function newEntry(path: string, meta: CodexThreadMeta, modifiedAt: number): TrackedRollout {
  return { path, meta, modifiedAt, cursor: null, state: EMPTY_CODEX_TURN_STATE, status: 'read' }
}

function parseRecords(
  lines: readonly string[],
  options: { includeToolInputs?: boolean } = {}
): CodexRecord[] {
  const records: CodexRecord[] = []
  for (const line of lines) {
    const record = parseRecord(line, options)
    if (record !== null) records.push(record)
  }
  return records
}

function lastActivityAt(entry: TrackedRollout): number {
  return entry.state.lastRecordAt ?? entry.modifiedAt
}

function newestFirst(a: TrackedRollout, b: TrackedRollout): number {
  return lastActivityAt(b) - lastActivityAt(a) || a.meta.id.localeCompare(b.meta.id)
}
