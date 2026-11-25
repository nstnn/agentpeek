import {
  parseAnnotationTitle,
  parseRecord,
  type AntigravityRecord
} from '../../core/antigravity/records'
import { type AntigravityFileStatus, antigravitySessionFacts } from '../../core/antigravity/facts'
import { antigravityMessages } from '../../core/antigravity/messages'
import {
  type AntigravityTurnState,
  EMPTY_ANTIGRAVITY_TURN_STATE,
  foldAntigravityRecords
} from '../../core/antigravity/turn-state'
import type { ToolHealth } from '../../core/health'
import type { SkillContent, SkillRequest } from '../../core/skills'
import type {
  RecentMessages,
  SessionFacts,
  SessionKey,
  SessionReply,
  SessionSummary
} from '../../core/session'
import { type AccessGate, createAccessGate, createSkillAccessGate } from './access'
import { isAntigravityAppRunning } from './app-running'
import {
  annotationPath,
  antigravityPaths,
  classifyAntigravityPath,
  isConversationId,
  listTranscripts,
  statTranscript,
  transcriptSignature,
  type TranscriptFile
} from './antigravity-files'
import { statFile } from './claude-files'
import { readFirstLine, readLastLines } from './jsonl-reader'
import { DEFAULT_LISTING_RANGE, type ListingRange, type SessionSource } from './session-source'
import { readSmallFile } from './small-file-reader'
import { readLocalSkill } from './skill-reader'
import { createQueue, isMissing } from './source-support'

// The Antigravity Desktop source. The reader (TASK-004) lists the user's local Antigravity
// conversations and reports normalized facts; `createAntigravitySource` (TASK-005) wraps it as a
// session source, adds whether the app runs, and maps the facts to the session model.
// - Which conversations: at each reconcile, a metadata-only listing of `brain/` finds the
//   transcripts and their modification times. The newest in the listing range (7 days by default)
//   are classified with bounded reads. A user prompt is required and an initial system message
//   marks a subagent transcript (DECISION-001). Unchanged classifications are reused. Up to the
//   range's cap (50 by default) are kept, plus saved pins.
// - Turns: each changed version is read from a bounded tail. This keeps facts and detail on the
//   same version even when a rewrite keeps the inode and grows the file.
// - Titles: `annotations/<id>.pbtxt`, read only for listed conversations and only when the file
//   changed (DECISION-002). The workspace is never known: `null`.
// - Live updates: Antigravity opens, appends, and closes the transcript on every step, so a folder
//   watch on `brain/` sees each append (TASK-001). No file needs its own watch.
// - Skills: a `/name` prompt names the skill's SKILL.md, never its text. `skill` reauthorizes the
//   request against the prompt in the current tail, then reads the file through the skill gate,
//   which adds Antigravity's own `.gemini/config/skills`. A skill in a project folder is refused:
//   Antigravity never says which folder a conversation works in.
// The catalog reads records without their text. Message text is read only by `recentMessages` and
// `skill`, is never kept, and is never logged.

export interface AntigravityReaderOptions {
  /** The home folder: the user's, or `AGENTPEEK_HOME` in fixture mode. */
  home: string
  /** The access gate for `home`. Tests pass one that records what it opens. */
  gate?: AccessGate
  /** The listing range, read at each listing. The default range when absent. */
  range?: () => ListingRange
  /** Saved pin IDs, exempt from recent-session limits. */
  pinnedIds?: () => readonly string[]
  /** The clock, in epoch milliseconds. */
  now?: () => number
  /** Fixture mode: skill reads stay inside `home`, symlinks included. */
  fixture?: boolean
}

/** Where Antigravity Desktop keeps the user's skills, under the home folder (observed 2026-11-25). */
export const ANTIGRAVITY_SKILL_FOLDERS = ['.gemini/config/skills'] as const

export type { AntigravityFileStatus } from '../../core/antigravity/facts'

/** What the reader reports about one conversation. No message text. */
export interface AntigravityConversationFacts {
  conversationId: string
  /** The title from the annotation file, or null; the workspace is always null (DECISION-002). */
  summary: SessionSummary
  fileStatus: AntigravityFileStatus
  /** See `AntigravityTurnState.lastTurnStep`. */
  lastTurnStep: 'open' | 'ended' | null
  /** The latest final reply. Its cursor is stable across rereads of the same record. */
  lastReply: SessionReply | null
}

export interface AntigravityReader {
  /** Lists the conversations and reads what changed in them. Newest activity first. */
  catalog(): Promise<AntigravityConversationFacts[]>
  /** Reads only the transcripts and titles named by `changedPaths`; ignores any other path. */
  refresh(changedPaths: readonly string[]): Promise<AntigravityConversationFacts[]>
  /** A listed conversation's recent prompts, final replies, and tool-call groups, at most `limit`. */
  recentMessages(conversationId: string, limit: number): Promise<RecentMessages>
  /** The SKILL.md a recent `/name` prompt asked for, only when the prompt still names it. */
  skill(conversationId: string, request: SkillRequest): Promise<SkillContent>
  health(): ToolHealth
  olderAvailable(): boolean
}

/** A listed conversation and what has been read of it. */
interface TrackedConversation {
  file: TranscriptFile
  state: AntigravityTurnState
  status: AntigravityFileStatus
}

type Inspection =
  { kind: 'user'; entry: TrackedConversation } | { kind: 'excluded' | 'unsupported' | 'unreadable' }

/**
 * The tail read of a transcript, in growing steps. It stops at the first step that holds a turn
 * step. Antigravity cuts long fields to about 4 KB in `transcript.jsonl`, so steps are small.
 */
const TAIL_STEPS_BYTES = [256 * 1024, 2 * 1024 * 1024] as const
const PREFIX_MAX_BYTES = 256 * 1024

/**
 * How many recent candidates one listing may newly read and reject, per listed session (at least
 * `MIN_REJECT_BUDGET`). Subagent transcripts often outnumber conversations, so the budget must reach
 * past them on the first listing.
 */
const REJECT_BUDGET_PER_SESSION = 4
const MIN_REJECT_BUDGET = 8

/** The tail read for the detail's messages. */
const MESSAGES_TAIL_BYTES = 2 * 1024 * 1024

/** The cap for an annotation file (DECISION-002). */
const ANNOTATION_MAX_BYTES = 64 * 1024

/** The line limit for reads that only the byte budget limits. */
const ALL_LINES = Number.MAX_SAFE_INTEGER

export function createAntigravityReader(options: AntigravityReaderOptions): AntigravityReader {
  const paths = antigravityPaths(options.home)
  const gate = options.gate ?? createAccessGate(options.home)
  const now = options.now ?? Date.now
  const range = () => options.range?.() ?? DEFAULT_LISTING_RANGE

  const inspected = new Map<string, { signature: string; result: Inspection }>()
  const tracked = new Map<string, TrackedConversation>()
  // A rewrite cannot undo a later user prompt already observed for this UUID.
  const promptSteps = new Map<string, number>()
  const titles = new Map<string, { signature: string | null; title: string | null }>()
  const older = new Set<string>()
  let health: ToolHealth = { state: 'checking' }
  let lastReadAt: number | null = null
  const serialized = createQueue()

  async function reconcile(): Promise<AntigravityConversationFacts[]> {
    const startedAt = now()
    const { windowMs, maxPerTool } = range()
    older.clear()
    let files: TranscriptFile[]
    try {
      files = await listTranscripts(paths)
    } catch (error) {
      health = isMissing(error) ? { state: 'not-installed' } : { state: 'no-access', lastReadAt }
      tracked.clear()
      titles.clear()
      inspected.clear()
      return []
    }
    const present = new Set(files.map((file) => file.conversationId))
    for (const id of inspected.keys()) if (!present.has(id)) inspected.delete(id)

    const pins = new Set(options.pinnedIds?.() ?? [])
    let recentCount = 0
    // Bound the new reads spent on recent candidates that are not listed (subagents, unsupported or
    // unreadable files). Listed ones are bounded by the cap. Rejected versions are cached, so a later
    // listing (such as Load Older Sessions) goes further.
    let rejectBudget = Math.max(MIN_REJECT_BUDGET, REJECT_BUDGET_PER_SESSION * maxPerTool)
    // Confirm more than one omitted conversation so removing one does not hide another.
    let olderBudget = Math.max(2, maxPerTool)
    let recognized = 0
    let unsupported = 0
    const kept: TrackedConversation[] = []
    for (const file of files.sort(newestFileFirst)) {
      const id = file.conversationId
      const pinned = pins.has(id)
      const recent = startedAt - file.modifiedAt <= windowMs && recentCount < maxPerTool
      const cached = cachedInspection(file)
      if (!pinned && cached === undefined) {
        if (recent) {
          if (rejectBudget <= 0) {
            // Not classified yet: it may be a conversation, so offer to look further.
            older.add(id)
            continue
          }
        } else {
          if (olderBudget <= 0) {
            // SessionSource allows an approximate older hint for candidates beyond the read budget.
            older.add(id)
            continue
          }
          olderBudget--
        }
      }
      const result = cached ?? (await inspectTranscript(file))
      if (result.kind === 'unsupported') unsupported++
      else if (result.kind !== 'unreadable') recognized++
      const entry = eligibleEntry(file, result)
      if (entry === undefined) {
        if (!pinned && recent && cached === undefined) rejectBudget--
        continue
      }
      if (!pinned && !recent) {
        if (result.kind === 'user') older.add(id)
        continue
      }
      kept.push(entry)
      if (!pinned) recentCount++
    }
    keep(kept)
    await readTitles()

    lastReadAt = startedAt
    health =
      recognized === 0 && unsupported > 0
        ? { state: 'unsupported', toolVersion: null }
        : { state: 'connected', lastReadAt: startedAt }
    return facts()
  }

  async function refresh(changedPaths: readonly string[]): Promise<AntigravityConversationFacts[]> {
    let readAny = false
    let recognizedTranscript = false
    for (const path of new Set(changedPaths)) {
      const kind = classifyAntigravityPath(paths, path)
      if (kind.kind === 'other') continue
      readAny = true
      const id = kind.conversationId
      if (kind.kind === 'annotation') {
        if (tracked.has(id)) await readTitle(id)
        continue
      }
      older.delete(id)
      const file = await statTranscript(paths, id)
      let entry: TrackedConversation | undefined
      if (file === null) {
        inspected.delete(id)
      } else {
        const result = await inspectTranscript(file, true)
        if (result.kind === 'user' || result.kind === 'excluded') recognizedTranscript = true
        entry = eligibleEntry(file, result)
      }
      if (entry === undefined) {
        tracked.delete(id)
        titles.delete(id)
      } else {
        tracked.set(id, entry)
      }
    }
    keep([...tracked.values()])
    await readTitles({ onlyMissing: true })
    if (
      readAny &&
      (health.state === 'connected' || (health.state === 'unsupported' && recognizedTranscript))
    ) {
      lastReadAt = now()
      health = { state: 'connected', lastReadAt }
    }
    return facts()
  }

  function cachedInspection(file: TranscriptFile): Inspection | undefined {
    const cached = inspected.get(file.conversationId)
    return cached?.signature === file.signature ? cached.result : undefined
  }

  function eligibleEntry(
    file: TranscriptFile,
    result: Inspection
  ): TrackedConversation | undefined {
    if (result.kind === 'user') return result.entry
    const previous = tracked.get(file.conversationId)
    if (result.kind === 'unreadable' && previous?.file.fileId === file.fileId) {
      return { ...previous, file, status: 'unreadable' }
    }
    return undefined
  }

  /** Check the descriptor against the no-symlink stat before any transcript bytes are read. */
  function transcriptGate(file: TranscriptFile): AccessGate {
    return {
      resolve: (path) => gate.resolve(path),
      async open(path) {
        const handle = await gate.open(path)
        try {
          if (transcriptSignature(await handle.stat({ bigint: true })) === file.signature) {
            return handle
          }
          throw new Error('The Antigravity transcript changed before it was read.')
        } catch (error) {
          await handle.close()
          throw error
        }
      }
    }
  }

  async function stillCurrent(file: TranscriptFile): Promise<boolean> {
    return (await statTranscript(paths, file.conversationId))?.signature === file.signature
  }

  async function inspectTranscript(
    file: TranscriptFile,
    retryUnreadable = false
  ): Promise<Inspection> {
    const cached = cachedInspection(file)
    if (cached !== undefined && (cached.kind !== 'unreadable' || !retryUnreadable)) return cached
    const previous = inspected.get(file.conversationId)?.result
    const readGate = transcriptGate(file)
    try {
      const result = await readTranscript(file, readGate, previous)
      if (!(await stillCurrent(file))) return { kind: 'unreadable' }
      if (result.kind === 'user') rememberPrompts(result.entry)
      inspected.set(file.conversationId, { signature: file.signature, result })
      return result
    } catch (error) {
      const result = { kind: 'unreadable' } as const
      // An unreadable file should not consume discovery budget on every listing. A permission
      // change changes its signature, and a named refresh or detail can retry the current version.
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error.code === 'EACCES' || error.code === 'EPERM') &&
        (await stillCurrent(file))
      ) {
        inspected.set(file.conversationId, { signature: file.signature, result })
      }
      return result
    }
  }

  async function readTranscript(
    file: TranscriptFile,
    readGate: AccessGate,
    previous: Inspection | undefined
  ): Promise<Inspection> {
    let prefixHasPrompt = false
    let startsWithSystem = false
    let sawSupported = false
    let sawLine = false
    const prefix = await readFirstLine(readGate, file.path, PREFIX_MAX_BYTES, (line) => {
      sawLine = true
      const record = parseRecord(line, { fallbackAt: file.modifiedAt })
      if (record === null || record.kind === 'other') return false
      prefixHasPrompt = record.kind === 'user-input'
      startsWithSystem = !sawSupported && record.kind === 'system-message'
      sawSupported = true
      return prefixHasPrompt || startsWithSystem
    })
    if (startsWithSystem) return { kind: 'excluded' }
    if (prefix.kind === 'none')
      return { kind: sawLine && !sawSupported ? 'unsupported' : 'excluded' }

    for (const maxBytes of TAIL_STEPS_BYTES) {
      const tail = await readLastLines(readGate, file.path, { maxLines: ALL_LINES, maxBytes })
      const records = parseRecords(tail.lines, file.modifiedAt)
      const state = foldAntigravityRecords(EMPTY_ANTIGRAVITY_TURN_STATE, records)
      const hasPrompt = prefixHasPrompt || state.lastUserStep !== null
      if (
        (hasPrompt && state.lastTurnStep !== null) ||
        tail.reachedStart ||
        maxBytes === TAIL_STEPS_BYTES[1]
      ) {
        const hasSupportedTail = records.some(({ kind }) => kind !== 'other')
        if (hasPrompt) {
          // An unchanged reply with an mtime fallback keeps its first completion time across rereads.
          const priorReply = previous?.kind === 'user' ? previous.entry.state.lastReply : null
          if (priorReply !== null && state.lastReply?.cursor === priorReply.cursor) {
            state.lastReply = { ...state.lastReply, completedAt: priorReply.completedAt }
          }
          const status = tail.lines.length > 0 && !hasSupportedTail ? 'unsupported' : 'read'
          return { kind: 'user', entry: { file, state, status } }
        }
        return { kind: sawSupported || hasSupportedTail ? 'excluded' : 'unsupported' }
      }
    }
    return { kind: 'unsupported' }
  }

  function rememberPrompts({ file, state }: TrackedConversation): void {
    if (state.lastUserStep === null) return
    const id = file.conversationId
    const previous = promptSteps.get(id) ?? -1
    if (state.lastUserStep > previous) promptSteps.set(id, state.lastUserStep)
  }

  /**
   * Reads the titles of listed conversations whose annotation file changed (or, with `onlyMissing`,
   * that have none read yet), and forgets the titles of conversations no longer listed.
   */
  async function readTitles(options: { onlyMissing?: boolean } = {}): Promise<void> {
    for (const id of titles.keys()) if (!tracked.has(id)) titles.delete(id)
    for (const id of tracked.keys()) {
      if (options.onlyMissing === true && titles.has(id)) continue
      await readTitle(id)
    }
  }

  async function readTitle(conversationId: string): Promise<void> {
    // Only IDs from a listing or a classified path get here, so the path stays inside annotations/.
    if (!isConversationId(conversationId)) return
    const path = annotationPath(paths, conversationId)
    const file = await statFile(path)
    const signature = file?.signature ?? null
    const cached = titles.get(conversationId)
    if (cached !== undefined && cached.signature === signature) return
    let title: string | null = null
    if (file !== null) {
      try {
        const read = await readSmallFile(gate, path, ANNOTATION_MAX_BYTES)
        title = read.kind === 'text' ? parseAnnotationTitle(read.text) : null
      } catch {
        // A missing, refused, or unreadable annotation only costs the title.
        title = null
      }
    }
    titles.set(conversationId, { signature, title })
  }

  /**
   * Keeps the conversations to list: active within the range, newest first, at most the range's
   * cap, plus saved pins. The rest are no longer tracked.
   */
  function keep(entries: readonly TrackedConversation[]): void {
    const { windowMs, maxPerTool } = range()
    const cutoff = now() - windowMs
    const pins = new Set(options.pinnedIds?.() ?? [])
    tracked.clear()
    let recentCount = 0
    for (const entry of [...entries].sort(newestFirst)) {
      const id = entry.file.conversationId
      const pinned = pins.has(id)
      if (!pinned && (recentCount >= maxPerTool || lastActivityAt(entry) < cutoff)) {
        if (entry.status !== 'unreadable') older.add(id)
        continue
      }
      if (!pinned) recentCount++
      older.delete(id)
      tracked.set(id, entry)
    }
  }

  function facts(): AntigravityConversationFacts[] {
    return [...tracked.values()].sort(newestFirst).map((entry) => ({
      conversationId: entry.file.conversationId,
      summary: {
        title: titles.get(entry.file.conversationId)?.title ?? null,
        workspacePath: null,
        lastActivityAt: lastActivityAt(entry),
        toolVersion: null
      },
      fileStatus: entry.status,
      lastTurnStep: entry.status === 'read' ? entry.state.lastTurnStep : null,
      lastReply: lastReply(entry)
    }))
  }

  function lastReply({ file, state, status }: TrackedConversation): SessionReply | null {
    const reply = state.lastReply
    if (status !== 'read' || reply === null || state.lastReplyStep === null) return null
    const promptStep = promptSteps.get(file.conversationId) ?? -1
    return state.lastReplyStep < promptStep && !reply.newerTurnStarted
      ? { ...reply, newerTurnStarted: true }
      : reply
  }

  /** The current tail's records, with text, of a listed conversation. */
  async function detailRecords(
    conversationId: string
  ): Promise<
    { kind: 'records'; records: AntigravityRecord[]; reachedStart: boolean } | RecentMessages
  > {
    if (!tracked.has(conversationId)) return { kind: 'not-found' }
    const file = await statTranscript(paths, conversationId)
    if (file === null) return { kind: 'unreadable' }
    const result = await inspectTranscript(file, true)
    if (result.kind !== 'user') {
      return result.kind === 'unreadable' ? { kind: 'unreadable' } : { kind: 'not-found' }
    }
    try {
      const tail = await readLastLines(transcriptGate(file), file.path, {
        maxLines: ALL_LINES,
        maxBytes: MESSAGES_TAIL_BYTES
      })
      if (!(await stillCurrent(file))) return { kind: 'unreadable' }
      const records = parseRecords(tail.lines, file.modifiedAt, true)
      return { kind: 'records', records, reachedStart: tail.reachedStart }
    } catch {
      return { kind: 'unreadable' }
    }
  }

  async function recentMessages(conversationId: string, limit: number): Promise<RecentMessages> {
    const read = await detailRecords(conversationId)
    if (read.kind !== 'records') return read
    const messages = antigravityMessages(read.records)
    const count = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0
    return {
      kind: 'messages',
      messages: messages.slice(Math.max(0, messages.length - count)),
      hasOlder: messages.length > count || !read.reachedStart
    }
  }

  async function skill(conversationId: string, request: SkillRequest): Promise<SkillContent> {
    const read = await detailRecords(conversationId)
    if (read.kind !== 'records') {
      return {
        kind: 'unavailable',
        reason: read.kind === 'unreadable' ? 'unreadable' : 'not-found'
      }
    }
    const asked = read.records.some(
      (record) =>
        record.kind === 'user-input' &&
        record.at === request.at &&
        record.skill?.name === request.name &&
        record.skill.path === request.path
    )
    if (!asked) return { kind: 'unavailable', reason: 'not-found' }
    const skillGate = createSkillAccessGate(
      options.home,
      null,
      options.fixture === true,
      ANTIGRAVITY_SKILL_FOLDERS
    )
    return readLocalSkill(request.path, skillGate)
  }

  return {
    catalog: () => serialized(reconcile),
    refresh: (changedPaths) => serialized(() => refresh(changedPaths)),
    recentMessages: (id, limit) => serialized(() => recentMessages(id, limit)),
    skill: (id, request) => serialized(() => skill(id, request)),
    health: () => health,
    olderAvailable: () => older.size > 0
  }
}

function parseRecords(
  lines: readonly string[],
  fallbackAt: number,
  includeText = false
): AntigravityRecord[] {
  const records: AntigravityRecord[] = []
  for (const line of lines) {
    const record = parseRecord(line, { includeText, fallbackAt })
    if (record !== null) records.push(record)
  }
  return records
}

function lastActivityAt(entry: TrackedConversation): number {
  return Math.max(entry.state.lastRecordAt ?? 0, entry.file.modifiedAt)
}

function newestFileFirst(a: TranscriptFile, b: TranscriptFile): number {
  return b.modifiedAt - a.modifiedAt || a.conversationId.localeCompare(b.conversationId)
}

function newestFirst(a: TrackedConversation, b: TrackedConversation): number {
  return (
    lastActivityAt(b) - lastActivityAt(a) ||
    a.file.conversationId.localeCompare(b.file.conversationId)
  )
}

export interface AntigravitySourceOptions extends AntigravityReaderOptions {
  /** Whether Antigravity Desktop is confirmed running. Tests and fixture mode pass their own. */
  isAppRunning?: () => Promise<boolean>
}

/** How long one answer of the app check is reused, as for Codex. */
const APP_CHECK_MAX_AGE_MS = 5000

/**
 * The Antigravity session source (TASK-005). An open-looking turn is Running only while
 * `com.google.antigravity` runs and the transcript was written within the quiet limit; the
 * activity rule in src/core applies that (DECISION-004). Antigravity closes its transcript after
 * each append, so the folder watch on `brain/` sees every change and no file needs its own watch.
 */
export function createAntigravitySource(options: AntigravitySourceOptions): SessionSource {
  const reader = createAntigravityReader(options)
  const isAppRunning = options.isAppRunning ?? isAntigravityAppRunning
  const now = options.now ?? Date.now
  let appCheck: { at: number; running: boolean } | null = null
  // The app check runs after the reader, so the whole read is queued here as well: the service
  // relies on reads of one source finishing in the order they were asked for.
  const serialized = createQueue()

  /** Checks the app only when a listed conversation has an open turn: only then does it matter. */
  async function checkApp(conversations: readonly AntigravityConversationFacts[]): Promise<void> {
    if (!conversations.some((conversation) => conversation.lastTurnStep === 'open')) return
    const at = now()
    if (appCheck !== null && at - appCheck.at < APP_CHECK_MAX_AGE_MS) return
    const running = await isAppRunning().catch(() => false)
    appCheck = { at, running }
  }

  function read(task: () => Promise<AntigravityConversationFacts[]>): Promise<SessionFacts[]> {
    return serialized(async () => {
      const conversations = await task()
      await checkApp(conversations)
      const appRunning = appCheck?.running ?? false
      return conversations.map((conversation) =>
        antigravitySessionFacts({ ...conversation, appRunning })
      )
    })
  }

  return {
    tool: 'antigravity',
    catalog: () => read(() => reader.catalog()),
    refresh: (changedPaths) => read(() => reader.refresh(changedPaths)),
    recentMessages: (key: SessionKey, limit: number) =>
      key.tool === 'antigravity'
        ? reader.recentMessages(key.id, limit)
        : Promise.resolve({ kind: 'not-found' }),
    getSkill: (key: SessionKey, request: SkillRequest) =>
      key.tool === 'antigravity'
        ? reader.skill(key.id, request)
        : Promise.resolve({ kind: 'unavailable', reason: 'not-found' }),
    health: () => reader.health(),
    olderAvailable: () => reader.olderAvailable(),
    watchedFiles: () => []
  }
}
