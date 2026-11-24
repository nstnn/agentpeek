import {
  parseAnnotationTitle,
  parseRecord,
  type AntigravityRecord
} from '../../core/antigravity/records'
import { antigravityMessages } from '../../core/antigravity/messages'
import {
  type AntigravityTurnState,
  EMPTY_ANTIGRAVITY_TURN_STATE,
  foldAntigravityRecords
} from '../../core/antigravity/turn-state'
import type { ToolHealth } from '../../core/health'
import type { RecentMessages, SessionReply, SessionSummary } from '../../core/session'
import { type AccessGate, createAccessGate } from './access'
import {
  annotationPath,
  antigravityPaths,
  classifyAntigravityPath,
  isConversationId,
  listTranscripts,
  statTranscript,
  type TranscriptFile
} from './antigravity-files'
import { statFile } from './claude-files'
import { type JsonlCursor, readFirstLine, readLastLines, readNewLines } from './jsonl-reader'
import { DEFAULT_LISTING_RANGE, type ListingRange } from './session-source'
import { readSmallFile } from './small-file-reader'
import { createQueue, isMissing } from './source-support'

// The Antigravity Desktop reader (TASK-004). It lists the user's local Antigravity conversations
// and reports normalized facts; TASK-005 registers it as a session source and maps the facts to
// activity and attention.
// - Which conversations: at each reconcile, a metadata-only listing of `brain/` finds the
//   transcripts and their modification times. The newest in the listing range (7 days by default)
//   are sorted out by their first step, read once per file: a user prompt lists the conversation, a
//   system message marks a subagent transcript, which is never listed (DECISION-001). Up to the
//   range's cap (50 by default) are kept, plus saved pins.
// - Turns: a kept transcript's tail is read once, then only the steps Antigravity appends (from a
//   cursor). A replaced, cut, or rewritten file is read again from its tail.
// - Titles: `annotations/<id>.pbtxt`, read only for listed conversations and only when the file
//   changed (DECISION-002). The workspace is never known: `null`.
// - Live updates: Antigravity opens, appends, and closes the transcript on every step, so a folder
//   watch on `brain/` sees each append (TASK-001). No file needs its own watch.
// The catalog reads records without their text. Message text is read only by `recentMessages`, is
// never kept, and is never logged.

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
}

/**
 * How the last read of a transcript went:
 * - `read`: it was read;
 * - `unreadable`: it could not be read (no permission, refused by the access gate, a read error);
 * - `unsupported`: it was read, but no step had the fields AgentPeek knows.
 */
export type AntigravityFileStatus = 'read' | 'unreadable' | 'unsupported'

/** What the reader reports about one conversation. No message text. */
export interface AntigravityConversationFacts {
  conversationId: string
  /** The title from the annotation file, or null; the workspace is always null (DECISION-002). */
  summary: SessionSummary
  fileStatus: AntigravityFileStatus
  /** See `AntigravityTurnState.lastTurnStep`. */
  lastTurnStep: 'open' | 'ended' | null
  /** The latest final reply. Its cursor is `<step_index>:<created_at>`. */
  lastReply: SessionReply | null
}

export interface AntigravityReader {
  /** Lists the conversations and reads what changed in them. Newest activity first. */
  catalog(): Promise<AntigravityConversationFacts[]>
  /** Reads only the transcripts and titles named by `changedPaths`; ignores any other path. */
  refresh(changedPaths: readonly string[]): Promise<AntigravityConversationFacts[]>
  /** A listed conversation's recent prompts, final replies, and tool-call groups, at most `limit`. */
  recentMessages(conversationId: string, limit: number): Promise<RecentMessages>
  health(): ToolHealth
  olderAvailable(): boolean
}

/** A listed conversation and what has been read of it. */
interface TrackedConversation {
  conversationId: string
  path: string
  modifiedAt: number
  /** Where the next read starts, or null when the tail must be read again. */
  cursor: JsonlCursor | null
  state: AntigravityTurnState
  status: AntigravityFileStatus
}

/** What a transcript's first step says about the conversation. */
type FirstStep =
  // A user prompt: a conversation to list.
  | 'user'
  // A system message: a subagent transcript, never listed.
  | 'subagent'
  // Another step, or a first line over the cap: listed only if its tail holds a user prompt.
  | 'other'
  // A first line without the step fields: Antigravity has changed its format.
  | 'unrecognized'

/** The result of looking up a transcript's first step, or why it was not read. */
type FirstStepLookup = FirstStep | 'not-yet' | 'skip'

/**
 * The tail read of a transcript, in growing steps. It stops at the first step that holds a turn
 * step. Antigravity cuts long fields to about 4 KB in `transcript.jsonl`, so steps are small.
 */
const TAIL_STEPS_BYTES = [256 * 1024, 2 * 1024 * 1024] as const

/** The most that is read of the steps added since the cursor. More starts over from the tail. */
const NEW_LINES_MAX_BYTES = 4 * 1024 * 1024

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

  /** First steps read so far, by conversation ID, with the file identity they were read from. */
  const firstSteps = new Map<string, { fileId: string; step: FirstStep }>()
  /** The listed conversations, by conversation ID. */
  const tracked = new Map<string, TrackedConversation>()
  /** Titles of listed conversations, with the annotation signature they were read at. */
  const titles = new Map<string, { signature: string | null; title: string | null }>()
  let health: ToolHealth = { state: 'checking' }
  let lastReadAt: number | null = null
  let older = false
  const serialized = createQueue()

  async function reconcile(): Promise<AntigravityConversationFacts[]> {
    const startedAt = now()
    const { windowMs, maxPerTool } = range()
    let files: TranscriptFile[]
    try {
      files = await listTranscripts(paths)
    } catch (error) {
      health = isMissing(error) ? { state: 'not-installed' } : { state: 'no-access', lastReadAt }
      tracked.clear()
      titles.clear()
      firstSteps.clear()
      return []
    }
    const present = new Set(files.map((file) => file.conversationId))
    for (const id of firstSteps.keys()) if (!present.has(id)) firstSteps.delete(id)

    const pins = new Set(options.pinnedIds?.() ?? [])
    const remainingPins = new Set([...pins].filter((id) => present.has(id)))
    let recentCount = 0
    let recognized = 0
    let unrecognized = 0
    older = false
    const kept: TrackedConversation[] = []
    for (const file of files.sort(newestFileFirst)) {
      const recentCandidate = startedAt - file.modifiedAt <= windowMs && recentCount < maxPerTool
      const pinned = pins.has(file.conversationId)
      if (!recentCandidate && !pinned) {
        older = true
        if (remainingPins.size === 0) break
        continue
      }
      remainingPins.delete(file.conversationId)
      const first = await firstStep(file)
      if (first === 'unrecognized') unrecognized++
      else if (first !== 'not-yet' && first !== 'skip') recognized++
      if (first === 'not-yet' || first === 'skip' || first === 'subagent') continue
      if (first === 'unrecognized') continue
      const entry = tracked.get(file.conversationId) ?? newEntry(file)
      entry.path = file.path
      entry.modifiedAt = file.modifiedAt
      if (!(await readTranscript(entry, { requireUserInput: first === 'other' }))) continue
      if (first === 'other' && !entry.state.hasUserInput) continue
      kept.push(entry)
      if (!pinned) recentCount++
    }
    keep(kept)
    await readTitles()

    lastReadAt = startedAt
    // Every first step is in a format AgentPeek does not know: Antigravity has changed its format.
    health =
      recognized === 0 && unrecognized > 0
        ? { state: 'unsupported', toolVersion: null }
        : { state: 'connected', lastReadAt: startedAt }
    return facts()
  }

  async function refresh(changedPaths: readonly string[]): Promise<AntigravityConversationFacts[]> {
    let readAny = false
    for (const path of new Set(changedPaths)) {
      const kind = classifyAntigravityPath(paths, path)
      if (kind.kind === 'other') continue
      readAny = true
      if (kind.kind === 'annotation') {
        if (tracked.has(kind.conversationId)) await readTitle(kind.conversationId)
        continue
      }
      const entry = tracked.get(kind.conversationId)
      if (entry === undefined) {
        await discover(kind.conversationId)
      } else if (
        !(await readTranscript(entry, {
          requireUserInput: firstSteps.get(kind.conversationId)?.step === 'other'
        }))
      ) {
        tracked.delete(kind.conversationId)
        titles.delete(kind.conversationId)
      }
    }
    keep([...tracked.values()])
    // Title changes arrive as annotation paths; here only newly listed conversations need one.
    await readTitles({ onlyMissing: true })
    if (readAny && health.state === 'connected') {
      lastReadAt = now()
      health = { state: 'connected', lastReadAt }
    }
    return facts()
  }

  /** A transcript the watcher reported that is not listed yet: a new or a resumed conversation. */
  async function discover(conversationId: string): Promise<void> {
    const file = await statTranscript(paths, conversationId)
    if (file === null) return
    const first = await firstStep(file)
    if (first !== 'user' && first !== 'other') return
    const entry = newEntry(file)
    if (!(await readTranscript(entry, { requireUserInput: first === 'other' }))) return
    if (first === 'other' && !entry.state.hasUserInput) return
    tracked.set(conversationId, entry)
  }

  async function firstStep(file: TranscriptFile): Promise<FirstStepLookup> {
    const fileId = file.signature.split(':').slice(0, 2).join(':')
    const cached = firstSteps.get(file.conversationId)
    if (cached !== undefined && cached.fileId === fileId) return cached.step
    let step: FirstStep
    try {
      const first = await readFirstLine(gate, file.path)
      if (first.kind === 'none') return 'not-yet'
      step = first.kind === 'too-long' ? 'other' : classifyFirstStep(parseRecord(first.line))
    } catch {
      return 'skip'
    }
    firstSteps.set(file.conversationId, { fileId, step })
    return step
  }

  /** Reads what is new in a transcript. Returns false when the file is gone. */
  async function readTranscript(
    entry: TrackedConversation,
    options: { requireUserInput?: boolean } = {}
  ): Promise<boolean> {
    try {
      if (entry.cursor !== null) {
        const added = await readNewLines(gate, entry.path, entry.cursor, {
          maxBytes: NEW_LINES_MAX_BYTES
        })
        if (added.kind === 'lines') {
          const records = parseRecords(added.lines)
          entry.cursor = added.cursor
          entry.state = foldAntigravityRecords(entry.state, records)
          if (records.length > 0) entry.status = 'read'
          return true
        }
        // The file was replaced, cut, rewritten, or grew too much: read its tail again.
      }
      await readTail(entry, options)
      return true
    } catch (error) {
      if (isMissing(error)) return false
      entry.status = 'unreadable'
      entry.cursor = null
      return true
    }
  }

  async function readTail(
    entry: TrackedConversation,
    options: { requireUserInput?: boolean } = {}
  ): Promise<void> {
    for (const maxBytes of TAIL_STEPS_BYTES) {
      const tail = await readLastLines(gate, entry.path, { maxLines: ALL_LINES, maxBytes })
      const records = parseRecords(tail.lines)
      entry.cursor = tail.cursor
      entry.state = foldAntigravityRecords(EMPTY_ANTIGRAVITY_TURN_STATE, records)
      entry.status = tail.lines.length > 0 && records.length === 0 ? 'unsupported' : 'read'
      const ready =
        entry.state.lastTurnStep !== null && (!options.requireUserInput || entry.state.hasUserInput)
      if (ready || tail.reachedStart) return
    }
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
      if (tracked.has(entry.conversationId)) continue
      const pinned = pins.has(entry.conversationId)
      if (!pinned && (recentCount >= maxPerTool || lastActivityAt(entry) < cutoff)) {
        older = true
        continue
      }
      if (!pinned) recentCount++
      tracked.set(entry.conversationId, entry)
    }
  }

  function facts(): AntigravityConversationFacts[] {
    return [...tracked.values()].sort(newestFirst).map((entry) => ({
      conversationId: entry.conversationId,
      summary: {
        title: titles.get(entry.conversationId)?.title ?? null,
        workspacePath: null,
        lastActivityAt: lastActivityAt(entry),
        toolVersion: null
      },
      fileStatus: entry.status,
      lastTurnStep: entry.status === 'read' ? entry.state.lastTurnStep : null,
      lastReply: entry.state.lastReply
    }))
  }

  async function recentMessages(conversationId: string, limit: number): Promise<RecentMessages> {
    const entry = tracked.get(conversationId)
    if (entry === undefined) return { kind: 'not-found' }
    try {
      const tail = await readLastLines(gate, entry.path, {
        maxLines: ALL_LINES,
        maxBytes: MESSAGES_TAIL_BYTES
      })
      const messages = antigravityMessages(parseRecords(tail.lines, { includeText: true }))
      const count = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0
      return {
        kind: 'messages',
        messages: messages.slice(Math.max(0, messages.length - count)),
        hasOlder: messages.length > count || !tail.reachedStart
      }
    } catch {
      return { kind: 'unreadable' }
    }
  }

  return {
    catalog: () => serialized(reconcile),
    refresh: (changedPaths) => serialized(() => refresh(changedPaths)),
    recentMessages,
    health: () => health,
    olderAvailable: () => older
  }
}

function classifyFirstStep(record: AntigravityRecord | null): FirstStep {
  if (record === null) return 'unrecognized'
  if (record.kind === 'user-input') return 'user'
  if (record.kind === 'system-message') return 'subagent'
  return 'other'
}

function newEntry(file: TranscriptFile): TrackedConversation {
  return {
    conversationId: file.conversationId,
    path: file.path,
    modifiedAt: file.modifiedAt,
    cursor: null,
    state: EMPTY_ANTIGRAVITY_TURN_STATE,
    status: 'read'
  }
}

function parseRecords(
  lines: readonly string[],
  options: { includeText?: boolean } = {}
): AntigravityRecord[] {
  const records: AntigravityRecord[] = []
  for (const line of lines) {
    const record = parseRecord(line, options)
    if (record !== null) records.push(record)
  }
  return records
}

function lastActivityAt(entry: TrackedConversation): number {
  return Math.max(entry.state.lastRecordAt ?? 0, entry.modifiedAt)
}

function newestFileFirst(a: TranscriptFile, b: TranscriptFile): number {
  return b.modifiedAt - a.modifiedAt || a.conversationId.localeCompare(b.conversationId)
}

function newestFirst(a: TrackedConversation, b: TrackedConversation): number {
  return lastActivityAt(b) - lastActivityAt(a) || a.conversationId.localeCompare(b.conversationId)
}
