import type { FileHandle } from 'node:fs/promises'
import type { AccessGate } from './access'

// A bounded reader for the tools' append-only JSONL files (one JSON record per line). It never reads
// a whole file (CONSTRAINT-005). It reads:
// - the first line, up to a cap (a Codex rollout's `session_meta`);
// - the last lines, backwards from the end, within a byte budget;
// - the lines added since an earlier read, from a saved cursor.
//
// It returns lines as text and leaves JSON decoding to the sources. Lines are split at line-feed
// bytes only, so a multi-byte character is never cut in two. A trailing `\r` is removed, blank lines
// are left out, and an unfinished last line (still being written) is held back until it ends.
// Every read goes through the access gate. The lines are conversation data: never log them.

/** Where reading stopped in a file, so the next read returns only the lines added since. */
export interface JsonlCursor {
  /** The file's identity (device and inode). A new identity means the file was replaced. */
  fileId: string
  /** The byte offset where the next read starts. */
  offset: number
  /**
   * True when `offset` is inside a line whose start was never read, because the line did not fit
   * in the read budget. The next read skips the rest of that line.
   */
  insideSkippedLine: boolean
}

export type FirstLineResult =
  | { kind: 'line'; line: string; bytesRead: number }
  // The file has no complete line yet: it is empty, or its first line is still being written.
  | { kind: 'none'; bytesRead: number }
  // No line ended within the cap.
  | { kind: 'too-long'; bytesRead: number }

export interface LastLinesResult {
  /** The last complete lines, oldest first. */
  lines: string[]
  /** True when the file has nothing older than the returned lines. */
  reachedStart: boolean
  /** Pass it to `readNewLines` to get the lines added after this read. */
  cursor: JsonlCursor
  bytesRead: number
}

/**
 * Why `readNewLines` could not continue from a cursor. The caller then starts over with
 * `readLastLines`.
 * - `replaced`: the path now holds a different file.
 * - `truncated`: the file is shorter than the cursor.
 * - `rewritten`: the byte before the cursor is no longer a line end, so the content changed.
 * - `too-far-behind`: more was added than the read budget allows.
 */
export type ResetReason = 'replaced' | 'truncated' | 'rewritten' | 'too-far-behind'

export type NewLinesResult =
  | { kind: 'lines'; lines: string[]; cursor: JsonlCursor; bytesRead: number }
  | { kind: 'reset'; reason: ResetReason; bytesRead: number }

/** The default cap for `readFirstLine`. A Codex `session_meta` line was about 22 KB in TASK-002. */
export const FIRST_LINE_MAX_BYTES = 1024 * 1024

/** How much is read at a time. */
const CHUNK_BYTES = 64 * 1024

const LINE_FEED = 0x0a
const CARRIAGE_RETURN = 0x0d
const SPACE = 0x20
const TAB = 0x09

/** Reads the first complete, non-blank line accepted by `matches`, up to `maxBytes`. */
export async function readFirstLine(
  gate: AccessGate,
  path: string,
  maxBytes = FIRST_LINE_MAX_BYTES,
  matches: (line: string) => boolean = () => true
): Promise<FirstLineResult> {
  const handle = await gate.open(path)
  try {
    let data = Buffer.alloc(0)
    let checked = 0
    while (data.length < maxBytes) {
      const length = Math.min(CHUNK_BYTES, maxBytes - data.length)
      const chunk = await readAt(handle, data.length, length)
      data = Buffer.concat([data, chunk])
      const { lines, unfinishedLineStart } = findCompleteLines(data.subarray(checked), true)
      for (const range of lines) {
        const line = decode(data.subarray(checked), range)
        if (matches(line)) return { kind: 'line', line, bytesRead: data.length }
      }
      checked += unfinishedLineStart ?? 0
      // A short read means the end of the file.
      if (chunk.length < length) return { kind: 'none', bytesRead: data.length }
    }
    return { kind: 'too-long', bytesRead: data.length }
  } finally {
    await handle.close()
  }
}

/**
 * Reads the last `maxLines` complete, non-blank lines, reading backwards from the end of the file
 * and at most `maxBytes`. A line longer than the budget is left out.
 */
export async function readLastLines(
  gate: AccessGate,
  path: string,
  options: { maxLines: number; maxBytes: number }
): Promise<LastLinesResult> {
  const handle = await gate.open(path)
  try {
    const { fileId, size } = await identify(handle)
    // `data` holds the bytes from `start` to the end of the file.
    let start = size
    let data = Buffer.alloc(0)
    let found = findCompleteLines(data, true)
    while (start > 0 && data.length < options.maxBytes && found.lines.length < options.maxLines) {
      const length = Math.min(CHUNK_BYTES, start, options.maxBytes - data.length)
      start -= length
      const chunk = await readAt(handle, start, length)
      if (chunk.length < length) throw new Error('The file got shorter while it was read.')
      data = Buffer.concat([chunk, data])
      // Unless `data` begins at the start of the file, its first bytes may end an older line.
      found = findCompleteLines(data, start === 0)
    }
    const lines = found.lines.slice(-options.maxLines).map((range) => decode(data, range))
    return {
      lines,
      reachedStart: start === 0 && found.lines.length <= options.maxLines,
      cursor: cursorAfter(fileId, start, data.length, found.unfinishedLineStart),
      bytesRead: data.length
    }
  } finally {
    await handle.close()
  }
}

/**
 * Reads the complete lines added since `cursor`, reading at most `maxBytes`. Use the returned
 * cursor for the next call. On a reset, call `readLastLines` again.
 */
export async function readNewLines(
  gate: AccessGate,
  path: string,
  cursor: JsonlCursor,
  options: { maxBytes: number }
): Promise<NewLinesResult> {
  const handle = await gate.open(path)
  try {
    const { fileId, size } = await identify(handle)
    if (fileId !== cursor.fileId) return { kind: 'reset', reason: 'replaced', bytesRead: 0 }
    if (size < cursor.offset) return { kind: 'reset', reason: 'truncated', bytesRead: 0 }
    if (size === cursor.offset) return { kind: 'lines', lines: [], cursor, bytesRead: 0 }

    // Start one byte early, to check that the cursor still sits right after a line end.
    const checkLineEnd = cursor.offset > 0 && !cursor.insideSkippedLine
    const start = checkLineEnd ? cursor.offset - 1 : cursor.offset
    if (size - start > options.maxBytes) {
      return { kind: 'reset', reason: 'too-far-behind', bytesRead: 0 }
    }
    const data = await readAt(handle, start, size - start)
    if (checkLineEnd && data[0] !== LINE_FEED) {
      return { kind: 'reset', reason: 'rewritten', bytesRead: data.length }
    }
    // After that line end the next line starts. A cursor at offset 0 is at the first line. A cursor
    // inside a skipped line must find the line's end first.
    const found = findCompleteLines(data, cursor.offset === 0)
    return {
      kind: 'lines',
      lines: found.lines.map((range) => decode(data, range)),
      cursor: cursorAfter(fileId, start, data.length, found.unfinishedLineStart),
      bytesRead: data.length
    }
  } finally {
    await handle.close()
  }
}

/** The byte range of one line in a buffer, without its line ending. */
interface LineRange {
  start: number
  end: number
}

interface FoundLines {
  /** The complete, non-blank lines. */
  lines: LineRange[]
  /**
   * Where the unfinished line after the last line feed starts (the buffer's length when there is
   * none), or null when the buffer has no line start at all: it lies inside one line.
   */
  unfinishedLineStart: number | null
}

/**
 * Finds the complete lines in `data`. A line is complete when a line feed ends it and its start is
 * known: either `startsAtLineStart` is true, or a line feed comes before it.
 */
function findCompleteLines(data: Buffer, startsAtLineStart: boolean): FoundLines {
  const lines: LineRange[] = []
  let lineStart: number | null = startsAtLineStart ? 0 : null
  let lineFeed = data.indexOf(LINE_FEED)
  while (lineFeed !== -1) {
    if (lineStart !== null) {
      const end =
        lineFeed > lineStart && data[lineFeed - 1] === CARRIAGE_RETURN ? lineFeed - 1 : lineFeed
      if (!isBlank(data, lineStart, end)) lines.push({ start: lineStart, end })
    }
    lineStart = lineFeed + 1
    lineFeed = data.indexOf(LINE_FEED, lineStart)
  }
  return { lines, unfinishedLineStart: lineStart }
}

function isBlank(data: Buffer, start: number, end: number): boolean {
  for (let index = start; index < end; index++) {
    const byte = data[index]
    if (byte !== SPACE && byte !== TAB && byte !== CARRIAGE_RETURN) return false
  }
  return true
}

function decode(data: Buffer, range: LineRange): string {
  return data.toString('utf8', range.start, range.end)
}

/** The cursor after reading `length` bytes from `start`. */
function cursorAfter(
  fileId: string,
  start: number,
  length: number,
  unfinishedLineStart: number | null
): JsonlCursor {
  return unfinishedLineStart === null
    ? { fileId, offset: start + length, insideSkippedLine: true }
    : { fileId, offset: start + unfinishedLineStart, insideSkippedLine: false }
}

async function identify(handle: FileHandle): Promise<{ fileId: string; size: number }> {
  // BigInt stats keep large inode numbers exact.
  const stats = await handle.stat({ bigint: true })
  return { fileId: `${stats.dev}:${stats.ino}`, size: Number(stats.size) }
}

/** Reads `length` bytes at `position`, or fewer when the file ends first. */
async function readAt(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length)
  let filled = 0
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled)
    if (bytesRead === 0) break
    filled += bytesRead
  }
  return buffer.subarray(0, filled)
}
