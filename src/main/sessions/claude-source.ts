import {
  type ClaudeFileStatus,
  claudeLastActivityAt,
  claudeSessionFacts
} from '../../core/claude/facts'
import { claudeMessages } from '../../core/claude/messages'
import {
  type CatalogFileResult,
  type ClaudeCatalogEntry,
  type ClaudeRecord,
  type ClaudeRegistryEntry,
  parseCatalogFile,
  parseRecord,
  parseRegistryFile,
  type RegistryFileResult
} from '../../core/claude/records'
import {
  type ClaudeTranscriptState,
  EMPTY_CLAUDE_TRANSCRIPT_STATE,
  foldClaudeRecords,
  marksTurn
} from '../../core/claude/transcript-state'
import type { ToolHealth } from '../../core/health'
import type { SessionFacts, SessionKey } from '../../core/session'
import { type AccessGate, createAccessGate } from './access'
import {
  checkFolder,
  classifyPath,
  claudePaths,
  findTranscript,
  type ListedFile,
  listCatalogFiles,
  listRegistryFiles,
  statFile
} from './claude-files'
import { type ProcessProbe, processProbe } from './claude-process'
import { type JsonlCursor, readLastLines, readNewLines } from './jsonl-reader'
import {
  MAX_SESSIONS_PER_TOOL,
  RECENT_SESSION_WINDOW_MS,
  type RecentMessages,
  type SessionSource
} from './session-source'
import { readSmallFile, type SmallFileResult } from './small-file-reader'
import { createQueue, isMissing } from './source-support'

// The Claude Code source (TASK-008). It lists the user's Claude Code sessions and reports their
// facts.
// - Which sessions (REQ-002): the sessions in Claude.app's catalog that are not archived, plus every
//   session in the runtime registry, which also covers a running CLI session. Both name a session by
//   its CLI session ID, which is also its transcript's file name. A session is listed only once its
//   transcript exists: Claude.app's short-lived helper processes have registry files but never a
//   transcript (TASK-003). The 50 newest sessions active in the last 7 days are kept, plus every
//   session whose registry says busy or waiting.
// - Activity comes from the registry (`busy`, `waiting`, `idle`), with a liveness check on the
//   registry's process. Replies, errors, and the custom title come from the transcript: its tail
//   once, then only the lines Claude Code adds.
// - Live updates: Claude Code closes its files after each write, so the service's folder watches see
//   every change (TASK-002), and `watchedFiles()` is always empty.
// Everything read here is conversation data: it is never logged or kept beyond what the facts hold.

export interface ClaudeSourceOptions {
  /** The home folder: the user's, or `AGENTPEEK_HOME` in fixture mode. */
  home: string
  /** The access gate for `home`. Tests pass one that records what it opens. */
  gate?: AccessGate
  /** The liveness check for registry processes. Tests and fixture mode pass their own. */
  probe?: ProcessProbe
  /** The clock, in epoch milliseconds. */
  now?: () => number
}

/** A catalog or registry file as last read, with the signature it had then. */
interface CachedFile<T> {
  signature: string
  result: T
}

/** A session as the catalog and the registry describe it. */
interface Candidate {
  id: string
  catalog: ClaudeCatalogEntry | null
  registry: ClaudeRegistryEntry | null
}

/** A listed session's transcript and what has been read of it. */
interface TrackedTranscript {
  path: string
  modifiedAt: number
  /** Where the next read starts, or null when the tail must be read again. */
  cursor: JsonlCursor | null
  state: ClaudeTranscriptState
  status: ClaudeFileStatus
}

/** How many files of one kind AgentPeek recognized, and how many it did not. */
interface FormatCount {
  recognized: number
  unrecognized: number
}

/** What listing one of Claude Code's folders found. */
type FolderListing =
  { kind: 'files'; files: ListedFile[] } | { kind: 'missing' } | { kind: 'no-access' }

/**
 * The tail read of a transcript, in growing steps. It stops at the first step that holds a prompt
 * or the end of a turn. Before that, every reply is followed by a prompt and no longer counts. On
 * this Mac, a finished turn's reply was at most 179 KB from the end (TASK-008).
 */
const TAIL_STEPS_BYTES = [256 * 1024, 2 * 1024 * 1024] as const

/** The most that is read of the lines added since the cursor. More starts over from the tail. */
const NEW_LINES_MAX_BYTES = 4 * 1024 * 1024

/** The tail read for the detail's messages. */
const MESSAGES_TAIL_BYTES = 2 * 1024 * 1024

/** The cap for catalog and registry files. The largest catalog file seen was 46 KB (TASK-008). */
const JSON_FILE_MAX_BYTES = 1024 * 1024

/** How long a liveness answer is reused, so a burst of file events runs the check once. */
const LIVENESS_MAX_AGE_MS = 5000

/** The line limit for reads that only the byte budget limits. */
const ALL_LINES = Number.MAX_SAFE_INTEGER

export function createClaudeSource(options: ClaudeSourceOptions): SessionSource {
  const paths = claudePaths(options.home)
  const gate = options.gate ?? createAccessGate(options.home)
  const probe = options.probe ?? processProbe
  const now = options.now ?? Date.now

  /** Catalog files modified in the last 7 days, by path. */
  const catalogFiles = new Map<string, CachedFile<CatalogFileResult>>()
  /** Registry files, by path. */
  const registryFiles = new Map<string, CachedFile<RegistryFileResult>>()
  /** Where each session's transcript was found, by session ID. */
  const transcriptPaths = new Map<string, string>()
  /** The listed sessions' transcripts, by session ID. */
  const tracked = new Map<string, TrackedTranscript>()
  /** The last liveness answer for each registry process. */
  const liveness = new Map<number, { procStart: string | null; at: number; alive: boolean }>()
  /** Whether the last reconcile could list the registry folder. A missing one counts: no process. */
  let registryReadable = true
  let health: ToolHealth = { state: 'checking' }
  let lastReadAt: number | null = null
  const serialized = createQueue()

  async function reconcile(): Promise<SessionFacts[]> {
    const startedAt = now()
    const [registry, catalog, projects] = await Promise.all([
      listFolder(() => listRegistryFiles(paths)),
      listFolder(() => listCatalogFiles(paths)),
      checkFolder(paths.projects)
    ])
    // Without the registry, no session's activity is known, so every session shows as Unknown
    // ("Can't read") rather than Idle. The entries read before are dropped: they may be out of date.
    registryReadable = registry.kind !== 'no-access'
    if (registry.kind === 'missing' && catalog.kind === 'missing' && projects === 'missing') {
      health = { state: 'not-installed' }
      forgetEverything()
      return []
    }
    await updateRegistry(registry.kind === 'files' ? registry.files : [])
    await updateCatalog(catalog.kind === 'files' ? catalog.files : [])
    const all = candidates()
    await select(all, true)
    await checkLiveness(all)

    if (registry.kind === 'no-access' || catalog.kind === 'no-access' || projects === 'no-access') {
      health = { state: 'no-access', lastReadAt }
    } else {
      lastReadAt = startedAt
      const format = formatCheck()
      health = format.changed
        ? { state: 'unsupported', toolVersion: format.version }
        : { state: 'connected', lastReadAt: startedAt }
    }
    return facts(all)
  }

  async function refresh(changedPaths: readonly string[]): Promise<SessionFacts[]> {
    let membershipChanged = false
    let readAny = false
    for (const path of new Set(changedPaths)) {
      const target = classifyPath(paths, path)
      if (target.kind === 'other') continue
      readAny = true
      if (target.kind === 'registry') {
        const file = await statFile(path)
        // A removed registry file means its process ended: the session is now idle.
        if (file === null) registryFiles.delete(path)
        else await readRegistry(path, file.signature)
        membershipChanged = true
      } else if (target.kind === 'catalog') {
        // Claude.app replaces a catalog file through a temporary file and a rename, so the file can
        // be missing for a moment. The rename's own event reads it again.
        const file = await statFile(path)
        if (file !== null) await readCatalog(path, file.signature)
        membershipChanged = true
      } else {
        const entry = tracked.get(target.sessionId)
        if (entry?.path === path) {
          if (!(await readTranscript(entry))) {
            tracked.delete(target.sessionId)
            membershipChanged = true
          }
        } else {
          // A transcript AgentPeek does not list yet, such as the first prompt of a new session.
          transcriptPaths.set(target.sessionId, path)
          membershipChanged = true
        }
      }
    }
    const all = candidates()
    if (membershipChanged) await select(all, false)
    await checkLiveness(all)
    if (readAny && health.state === 'connected') {
      lastReadAt = now()
      health = { state: 'connected', lastReadAt }
    }
    return facts(all)
  }

  async function listFolder(list: () => Promise<ListedFile[]>): Promise<FolderListing> {
    try {
      return { kind: 'files', files: await list() }
    } catch (error) {
      return isMissing(error) ? { kind: 'missing' } : { kind: 'no-access' }
    }
  }

  async function updateRegistry(files: readonly ListedFile[]): Promise<void> {
    const present = new Set(files.map((file) => file.path))
    for (const path of registryFiles.keys()) if (!present.has(path)) registryFiles.delete(path)
    for (const file of files) {
      if (registryFiles.get(file.path)?.signature !== file.signature) {
        await readRegistry(file.path, file.signature)
      }
    }
  }

  async function updateCatalog(files: readonly ListedFile[]): Promise<void> {
    const cutoff = now() - RECENT_SESSION_WINDOW_MS
    const present = new Set<string>()
    for (const file of files) {
      // Claude.app rewrites a catalog file whenever its session's activity time changes, so an
      // older file holds a session last active more than 7 days ago (107 of 107 files, TASK-008).
      // Such a session is still listed while its registry says busy or waiting.
      if (file.modifiedAt < cutoff) continue
      present.add(file.path)
      if (catalogFiles.get(file.path)?.signature !== file.signature) {
        await readCatalog(file.path, file.signature)
      }
    }
    for (const path of catalogFiles.keys()) if (!present.has(path)) catalogFiles.delete(path)
  }

  async function readRegistry(path: string, signature: string): Promise<void> {
    const read = await readJsonFile(path)
    if (read === 'gone') {
      registryFiles.delete(path)
      return
    }
    // A file that cannot be read now, or that Claude Code is rewriting, keeps what was read before.
    if (read === 'failed') return
    const result =
      read.kind === 'text'
        ? parseRegistryFile(read.text)
        : { kind: 'unrecognized' as const, version: null }
    if (result.kind !== 'malformed') registryFiles.set(path, { signature, result })
  }

  async function readCatalog(path: string, signature: string): Promise<void> {
    const read = await readJsonFile(path)
    // Claude.app replaces a catalog file through a temporary file and a rename, so a read can find
    // it missing for a moment: keep what was read before. The rename's own event reads it again,
    // and the next reconcile drops a file that is really gone.
    if (read === 'gone' || read === 'failed') return
    const result =
      read.kind === 'text' ? parseCatalogFile(read.text) : { kind: 'unrecognized' as const }
    if (result.kind !== 'malformed') catalogFiles.set(path, { signature, result })
  }

  async function readJsonFile(path: string): Promise<SmallFileResult | 'gone' | 'failed'> {
    try {
      return await readSmallFile(gate, path, JSON_FILE_MAX_BYTES)
    } catch (error) {
      return isMissing(error) ? 'gone' : 'failed'
    }
  }

  /** The sessions the catalog and the registry name, by session ID. Archived ones are left out. */
  function candidates(): Map<string, Candidate> {
    const all = new Map<string, Candidate>()
    const archived = new Set<string>()
    for (const { result } of catalogFiles.values()) {
      if (result.kind !== 'entry') continue
      const { entry } = result
      if (entry.isArchived) {
        archived.add(entry.cliSessionId)
        continue
      }
      // The same session in two catalog folders: the more recently active entry counts.
      const known = all.get(entry.cliSessionId)?.catalog ?? null
      if (known === null || (entry.lastActivityAt ?? 0) > (known.lastActivityAt ?? 0)) {
        all.set(entry.cliSessionId, { id: entry.cliSessionId, catalog: entry, registry: null })
      }
    }
    for (const { result } of registryFiles.values()) {
      if (result.kind !== 'entry') continue
      const { entry } = result
      if (archived.has(entry.sessionId)) continue
      const candidate = all.get(entry.sessionId) ?? {
        id: entry.sessionId,
        catalog: null,
        registry: null
      }
      // Two registry files for one session, such as one a crashed process left behind: the more
      // recently written one counts.
      if (
        candidate.registry === null ||
        (entry.updatedAt ?? 0) > (candidate.registry.updatedAt ?? 0)
      ) {
        all.set(entry.sessionId, { ...candidate, registry: entry })
      }
    }
    for (const id of archived) all.delete(id)
    return all
  }

  /**
   * Decides which sessions to list and reads the transcripts of those newly listed. With
   * `readTracked`, it also reads what was added to the transcripts already listed.
   */
  async function select(all: ReadonlyMap<string, Candidate>, readTracked: boolean): Promise<void> {
    const cutoff = now() - RECENT_SESSION_WINDOW_MS
    const found: { candidate: Candidate; transcript: ListedFile; activeAt: number }[] = []
    for (const candidate of all.values()) {
      const transcript = await locateTranscript(candidate)
      // No transcript: a helper process, or a session with no prompt yet.
      if (transcript === null) continue
      // The transcript's modification time is never earlier than its last record.
      const activeAt = Math.max(candidate.catalog?.lastActivityAt ?? 0, transcript.modifiedAt)
      found.push({ candidate, transcript, activeAt })
    }
    found.sort((a, b) => b.activeAt - a.activeAt || a.candidate.id.localeCompare(b.candidate.id))

    const kept = new Map<string, TrackedTranscript>()
    for (const { candidate, transcript, activeAt } of found) {
      const open = isOpen(candidate.registry)
      if (!open && (kept.size >= MAX_SESSIONS_PER_TOOL || activeAt < cutoff)) continue
      let entry = tracked.get(candidate.id)
      if (entry?.path !== transcript.path) {
        entry = newTranscript(transcript.path)
        if (!(await readTranscript(entry))) continue
      } else if (readTracked && !(await readTranscript(entry))) {
        continue
      }
      entry.modifiedAt = transcript.modifiedAt
      // `activeAt` can be later than the last activity: records without a time, such as a custom
      // title, also change the file's modification time. A session last active before the window
      // takes no place in the list.
      const lastActivityAt = claudeLastActivityAt({
        catalog: candidate.catalog,
        transcript: entry.state,
        transcriptModifiedAt: entry.modifiedAt
      })
      if (!open && lastActivityAt < cutoff) continue
      kept.set(candidate.id, entry)
    }
    tracked.clear()
    for (const [id, entry] of kept) tracked.set(id, entry)
    for (const id of transcriptPaths.keys()) if (!all.has(id)) transcriptPaths.delete(id)
  }

  async function locateTranscript(candidate: Candidate): Promise<ListedFile | null> {
    const known = transcriptPaths.get(candidate.id)
    if (known !== undefined) {
      const file = await statFile(known)
      if (file !== null) return file
      transcriptPaths.delete(candidate.id)
    }
    const workingFolders = [candidate.catalog?.cwd, candidate.registry?.cwd].filter(
      (cwd) => typeof cwd === 'string'
    )
    const file = await findTranscript(paths, candidate.id, workingFolders)
    if (file !== null) transcriptPaths.set(candidate.id, file.path)
    return file
  }

  /** Reads what is new in a transcript. Returns false when the file is gone. */
  async function readTranscript(entry: TrackedTranscript): Promise<boolean> {
    try {
      if (entry.cursor !== null) {
        const added = await readNewLines(gate, entry.path, entry.cursor, {
          maxBytes: NEW_LINES_MAX_BYTES
        })
        if (added.kind === 'lines') {
          const records = parseRecords(added.lines)
          entry.cursor = added.cursor
          entry.state = foldClaudeRecords(entry.state, records)
          if (records.length > 0) entry.status = 'read'
          return true
        }
        // The file was replaced, cut, rewritten, or grew too much: read its tail again.
      }
      await readTail(entry)
      return true
    } catch (error) {
      if (isMissing(error)) return false
      entry.status = 'unreadable'
      entry.cursor = null
      return true
    }
  }

  async function readTail(entry: TrackedTranscript): Promise<void> {
    for (const maxBytes of TAIL_STEPS_BYTES) {
      const tail = await readLastLines(gate, entry.path, { maxLines: ALL_LINES, maxBytes })
      const records = parseRecords(tail.lines)
      entry.cursor = tail.cursor
      entry.state = foldClaudeRecords(EMPTY_CLAUDE_TRANSCRIPT_STATE, records)
      // Lines, but none with the record shape AgentPeek knows: Claude Code has changed its format.
      entry.status = tail.lines.length > 0 && records.length === 0 ? 'unsupported' : 'read'
      if (tail.reachedStart || records.some(marksTurn)) return
    }
  }

  /** Checks the processes of the listed sessions whose registry says busy or waiting. */
  async function checkLiveness(all: ReadonlyMap<string, Candidate>): Promise<void> {
    const at = now()
    const checked = new Set<number>()
    for (const id of tracked.keys()) {
      const registry = all.get(id)?.registry ?? null
      if (registry === null || !isOpen(registry)) continue
      checked.add(registry.pid)
      const known = liveness.get(registry.pid)
      if (known?.procStart === registry.procStart && at - known.at < LIVENESS_MAX_AGE_MS) continue
      // A failed check trusts the registry rather than claiming the process ended.
      const alive = await probe.isAlive(registry.pid, registry.procStart).catch(() => true)
      liveness.set(registry.pid, { procStart: registry.procStart, at, alive })
    }
    for (const pid of liveness.keys()) if (!checked.has(pid)) liveness.delete(pid)
  }

  function facts(all: ReadonlyMap<string, Candidate>): SessionFacts[] {
    const cutoff = now() - RECENT_SESSION_WINDOW_MS
    const list: SessionFacts[] = []
    for (const [id, transcript] of tracked) {
      const candidate = all.get(id)
      // Its catalog entry was archived, or its process ended and it has no catalog entry.
      if (candidate === undefined) continue
      const { registry } = candidate
      const fact = claudeSessionFacts({
        sessionId: id,
        catalog: candidate.catalog,
        registry,
        registryReadable,
        ownerAlive: registry === null ? true : (liveness.get(registry.pid)?.alive ?? true),
        transcript: transcript.state,
        transcriptStatus: transcript.status,
        transcriptModifiedAt: transcript.modifiedAt
      })
      if (!isOpen(registry) && fact.summary.lastActivityAt < cutoff) continue
      list.push(fact)
    }
    return list.sort(
      (a, b) =>
        b.summary.lastActivityAt - a.summary.lastActivityAt || a.key.id.localeCompare(b.key.id)
    )
  }

  /**
   * Whether Claude Code has changed a format, for the Unsupported state: one kind of file (registry,
   * catalog, or transcript) has files, and AgentPeek recognized none of them. Each kind is checked
   * on its own, so a change to one is seen while the others still read. The version comes from the
   * registry, else a transcript.
   */
  function formatCheck(): { changed: boolean; version: string | null } {
    const registry: FormatCount = { recognized: 0, unrecognized: 0 }
    const catalog: FormatCount = { recognized: 0, unrecognized: 0 }
    const transcripts: FormatCount = { recognized: 0, unrecognized: 0 }
    let version: string | null = null
    for (const { result } of registryFiles.values()) {
      if (result.kind === 'entry') {
        registry.recognized++
        version ??= result.entry.version
      } else if (result.kind === 'unrecognized') {
        registry.unrecognized++
        version ??= result.version
      }
    }
    for (const { result } of catalogFiles.values()) {
      if (result.kind === 'entry') catalog.recognized++
      else if (result.kind === 'unrecognized') catalog.unrecognized++
    }
    for (const transcript of tracked.values()) {
      if (transcript.status === 'read') transcripts.recognized++
      else if (transcript.status === 'unsupported') transcripts.unrecognized++
      version ??= transcript.state.version
    }
    const changed = [registry, catalog, transcripts].some(
      (count) => count.recognized === 0 && count.unrecognized > 0
    )
    return { changed, version }
  }

  function forgetEverything(): void {
    catalogFiles.clear()
    registryFiles.clear()
    transcriptPaths.clear()
    tracked.clear()
    liveness.clear()
  }

  async function recentMessages(key: SessionKey, limit: number): Promise<RecentMessages> {
    const entry = key.tool === 'claude' ? tracked.get(key.id) : undefined
    if (entry === undefined) return { kind: 'not-found' }
    try {
      const tail = await readLastLines(gate, entry.path, {
        maxLines: ALL_LINES,
        maxBytes: MESSAGES_TAIL_BYTES
      })
      const messages = claudeMessages(parseRecords(tail.lines))
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
    tool: 'claude',
    catalog: () => serialized(reconcile),
    refresh: (changedPaths) => serialized(() => refresh(changedPaths)),
    recentMessages,
    health: () => health,
    // Claude Code closes its files after each write, so folder watches see every change.
    watchedFiles: () => []
  }
}

function newTranscript(path: string): TrackedTranscript {
  return { path, modifiedAt: 0, cursor: null, state: EMPTY_CLAUDE_TRANSCRIPT_STATE, status: 'read' }
}

function parseRecords(lines: readonly string[]): ClaudeRecord[] {
  const records: ClaudeRecord[] = []
  for (const line of lines) {
    const record = parseRecord(line)
    if (record !== null) records.push(record)
  }
  return records
}

/** Whether the registry says the session is busy or waiting: listed whatever its age. */
function isOpen(registry: ClaudeRegistryEntry | null): boolean {
  return registry?.status === 'busy' || registry?.status === 'waiting'
}
