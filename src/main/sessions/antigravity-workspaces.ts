import { constants as sqlite, DatabaseSync } from 'node:sqlite'
import { resolve, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AccessGate } from './access'
import { isConversationId } from './antigravity-files'
import { statFile } from './claude-files'

// Antigravity's working folders (DECISION-006 of the antigravity-desktop plan). Antigravity
// Desktop records each conversation's workspace only in `conversation_summaries.db`, a SQLite
// database in WAL mode. AgentPeek never lets SQLite open the tool's files: SQLite would lock them,
// and could write a journal, `-shm` index or checkpoint beside them. Instead the database and its
// `-wal` file are read whole and read-only through the access gate, the committed WAL frames are
// applied to an in-memory copy, and the copy is opened in memory. The one query below reads
// `conversation_id` and `workspace_uris` only; an authorizer refuses every other column, so titles,
// previews and search text are never read out of the copy. The copy is dropped after the query.
// The `-shm` file is never opened.

/** The cap for the database and for its WAL. The observed database is about 6 MB. */
const FILE_MAX_BYTES = 64 * 1024 * 1024

/** How often a changed database is reread when every listed conversation already has a row. */
const REREAD_INTERVAL_MS = 60 * 1000

/**
 * How often a changed database is reread for a listed conversation without a row. Antigravity
 * writes the database on every step, so this bounds the copies made during a long run.
 */
const MISSING_REREAD_MS = 5 * 1000

/** The longest folder path kept. Longer values are treated as no folder. */
const PATH_MAX_LENGTH = 4096

const TABLE = 'conversation_summaries'
const READ_COLUMNS = new Set(['conversation_id', 'workspace_uris'])
const QUERY = `SELECT conversation_id, workspace_uris FROM ${TABLE}`
const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'latin1')

export interface AntigravityWorkspaces {
  /**
   * Brings the index up to date for the listed conversations. It rereads the database when it or
   * its WAL changed: at most every 5 seconds while a listed conversation has no row, and once a
   * minute otherwise. A failed read keeps the last known folders.
   */
  update(conversationIds: Iterable<string>): Promise<void>
  /** The conversation's folder, or null when Antigravity records none. */
  get(conversationId: string): string | null
}

export interface AntigravityWorkspacesOptions {
  gate: AccessGate
  /** `~/.gemini/antigravity/conversation_summaries.db`. Its WAL is the same path plus `-wal`. */
  path: string
  now: () => number
}

export function createAntigravityWorkspaces(
  options: AntigravityWorkspacesOptions
): AntigravityWorkspaces {
  const walPath = `${options.path}-wal`
  let folders = new Map<string, string | null>()
  let readSignature: string | null = null
  let readAt = Number.NEGATIVE_INFINITY

  async function signature(): Promise<string | null> {
    const [database, wal] = await Promise.all([statFile(options.path), statFile(walPath)])
    return database === null ? null : `${database.signature}|${wal?.signature ?? '-'}`
  }

  async function update(conversationIds: Iterable<string>): Promise<void> {
    const before = await signature()
    if (before === null) {
      folders = new Map()
      readSignature = null
      return
    }
    if (before === readSignature) return
    const missing = [...conversationIds].some((id) => !folders.has(id))
    if (options.now() - readAt < (missing ? MISSING_REREAD_MS : REREAD_INTERVAL_MS)) return
    readAt = options.now()
    try {
      const database = await readWhole(options.gate, options.path)
      if (database === null || !database.subarray(0, SQLITE_HEADER.length).equals(SQLITE_HEADER)) {
        return
      }
      const wal = before.endsWith('|-') ? null : await readWhole(options.gate, walPath)
      // Files that changed while they were read may be torn: keep the old folders, retry later.
      if ((await signature()) !== before) return
      folders = workspaceRows(wal === null ? database : applyWal(database, wal))
      readSignature = before
    } catch {
      // Unreadable, or not the expected schema: keep the last known folders.
    }
  }

  return { update, get: (id) => folders.get(id) ?? null }
}

/** A whole file, or null when it is over the cap or changed size while it was read. */
async function readWhole(gate: AccessGate, path: string): Promise<Buffer | null> {
  const handle = await gate.open(path)
  try {
    const { size } = await handle.stat()
    if (size > FILE_MAX_BYTES) return null
    // One byte past the size shows a file that grew while it was read.
    const bytes = Buffer.alloc(size + 1)
    let total = 0
    while (total < bytes.length) {
      const { bytesRead } = await handle.read(bytes, total, bytes.length - total, total)
      if (bytesRead === 0) break
      total += bytesRead
    }
    return total === size ? bytes.subarray(0, size) : null
  } finally {
    await handle.close()
  }
}

const WAL_MAGIC = 0x377f0682
const WAL_HEADER_BYTES = 32
const WAL_FRAME_HEADER_BYTES = 24

/**
 * The database as of the WAL's last committed transaction, as a new buffer; `database` itself
 * when the WAL is empty, from an older generation, or not valid. A frame counts only when its
 * salts match the WAL header and its running checksum is valid, so a torn last frame and frames
 * left over from before a WAL reset are ignored, as SQLite's own recovery does.
 */
export function applyWal(database: Buffer, wal: Buffer): Buffer {
  if (database.length < 100 || wal.length < WAL_HEADER_BYTES) return database
  const magic = wal.readUInt32BE(0)
  if ((magic & ~1) !== WAL_MAGIC) return database
  const bigEndian = (magic & 1) === 1
  const pageSize = wal.readUInt32BE(8)
  const databasePageSize = database.readUInt16BE(16) === 1 ? 65536 : database.readUInt16BE(16)
  if (pageSize !== databasePageSize || pageSize < 512 || (pageSize & (pageSize - 1)) !== 0) {
    return database
  }
  let sums = checksum(wal, 0, 24, bigEndian, [0, 0])
  if (sums[0] !== wal.readUInt32BE(24) || sums[1] !== wal.readUInt32BE(28)) return database
  const salt1 = wal.readUInt32BE(16)
  const salt2 = wal.readUInt32BE(20)

  const frameBytes = WAL_FRAME_HEADER_BYTES + pageSize
  const pending = new Map<number, number>()
  const committed = new Map<number, number>()
  let pageCount: number | null = null
  for (let at = WAL_HEADER_BYTES; at + frameBytes <= wal.length; at += frameBytes) {
    if (wal.readUInt32BE(at + 8) !== salt1 || wal.readUInt32BE(at + 12) !== salt2) break
    sums = checksum(wal, at, 8, bigEndian, sums)
    sums = checksum(wal, at + WAL_FRAME_HEADER_BYTES, pageSize, bigEndian, sums)
    if (sums[0] !== wal.readUInt32BE(at + 16) || sums[1] !== wal.readUInt32BE(at + 20)) break
    const page = wal.readUInt32BE(at)
    if (page === 0) break
    pending.set(page, at + WAL_FRAME_HEADER_BYTES)
    const commitPages = wal.readUInt32BE(at + 4)
    if (commitPages !== 0) {
      for (const [number, offset] of pending) committed.set(number, offset)
      pending.clear()
      pageCount = commitPages
    }
  }
  if (pageCount === null || pageCount * pageSize > FILE_MAX_BYTES) return database
  const image = Buffer.alloc(pageCount * pageSize)
  database.copy(image, 0, 0, Math.min(database.length, image.length))
  for (const [page, offset] of committed) {
    if (page <= pageCount) wal.copy(image, (page - 1) * pageSize, offset, offset + pageSize)
  }
  return image
}

/** SQLite's WAL checksum over `length` bytes (a multiple of 8), continuing from `sums`. */
function checksum(
  bytes: Buffer,
  start: number,
  length: number,
  bigEndian: boolean,
  [first, second]: [number, number]
): [number, number] {
  const word = (at: number) => (bigEndian ? bytes.readUInt32BE(at) : bytes.readUInt32LE(at))
  let s0 = first
  let s1 = second
  for (let at = start; at < start + length; at += 8) {
    s0 = (s0 + word(at) + s1) >>> 0
    s1 = (s1 + word(at + 4) + s0) >>> 0
  }
  return [s0, s1]
}

/**
 * Reads `conversation_id` and `workspace_uris` from an in-memory copy of the database. Throws when
 * the copy cannot be opened or has no such table.
 */
export function workspaceRows(bytes: Buffer): Map<string, string | null> {
  const copy = Buffer.from(bytes)
  // Bytes 18 and 19 mark WAL mode, which an in-memory database cannot open. Clearing them in the
  // copy reads the same pages (the WAL is already applied); the tool's own file is never changed.
  copy[18] = 1
  copy[19] = 1
  const database = new DatabaseSync(':memory:')
  try {
    database.deserialize(copy)
    database.setAuthorizer((action, table, column) => {
      if (action === sqlite.SQLITE_SELECT) return sqlite.SQLITE_OK
      if (action === sqlite.SQLITE_READ && table === TABLE && READ_COLUMNS.has(column ?? '')) {
        return sqlite.SQLITE_OK
      }
      return sqlite.SQLITE_DENY
    })
    const folders = new Map<string, string | null>()
    for (const row of database.prepare(QUERY).iterate()) {
      const id = row.conversation_id
      if (typeof id !== 'string' || !isConversationId(id)) continue
      folders.set(id, workspaceFolder(row.workspace_uris))
    }
    return folders
  } finally {
    database.close()
  }
}

/** The first `file://` URI in a `workspace_uris` JSON array, as a normalized absolute path. */
export function workspaceFolder(value: unknown): string | null {
  if (typeof value !== 'string') return null
  let uris: unknown
  try {
    uris = JSON.parse(value)
  } catch {
    return null
  }
  if (!Array.isArray(uris)) return null
  for (const uri of uris) {
    if (typeof uri !== 'string' || !uri.startsWith('file:///')) continue
    let path: string
    try {
      path = fileURLToPath(uri)
    } catch {
      continue
    }
    if (!isAbsolute(path) || path.length > PATH_MAX_LENGTH || path.includes('\0')) continue
    const normalized = resolve(path)
    // A trailing slash is the same folder; `.` or `..` parts are refused.
    if (path === normalized || path === `${normalized}/`) return normalized
  }
  return null
}
