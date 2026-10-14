import { appendFile, mkdir, mkdtemp, rename, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type AccessGate, createAccessGate } from './access'
import {
  FIRST_LINE_MAX_BYTES,
  type JsonlCursor,
  type NewLinesResult,
  readFirstLine,
  readLastLines,
  readNewLines
} from './jsonl-reader'

// Synthetic records only. Each test writes a transcript-shaped file in a temporary home folder.
let home: string
let gate: AccessGate
let file: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'agentpeek-reader-'))
  gate = createAccessGate(home)
  const folder = join(home, '.claude', 'projects', '-synthetic-project')
  await mkdir(folder, { recursive: true })
  file = join(folder, 'session-1.jsonl')
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

function record(n: number): string {
  return JSON.stringify({ type: 'synthetic', n })
}

function records(from: number, to: number): string[] {
  return Array.from({ length: to - from + 1 }, (_, index) => record(from + index))
}

function jsonl(lines: readonly string[]): string {
  return lines.map((line) => `${line}\n`).join('')
}

const BIG = { maxLines: 1000, maxBytes: 1024 * 1024 }

function newLines(result: NewLinesResult): { lines: string[]; cursor: JsonlCursor } {
  if (result.kind !== 'lines') throw new Error(`Expected lines, got a reset (${result.reason}).`)
  return result
}

describe('readFirstLine', () => {
  it('returns the first line and reads only one chunk of a large file', async () => {
    await writeFile(file, jsonl(records(1, 20_000)))
    const result = await readFirstLine(gate, file)
    expect(result).toMatchObject({ kind: 'line', line: record(1) })
    expect(result.bytesRead).toBeLessThanOrEqual(64 * 1024)
  })

  it('removes a CRLF line ending and skips blank lines', async () => {
    await writeFile(file, `\n  \r\n${record(1)}\r\n${record(2)}\n`)
    expect(await readFirstLine(gate, file)).toMatchObject({ kind: 'line', line: record(1) })
  })

  it('reports no line for an empty file and for a first line that is still being written', async () => {
    await writeFile(file, '')
    expect(await readFirstLine(gate, file)).toMatchObject({ kind: 'none' })
    await writeFile(file, '{"type":"synth')
    expect(await readFirstLine(gate, file)).toMatchObject({ kind: 'none' })
  })

  it('finds a first line longer than one chunk', async () => {
    const long = JSON.stringify({ type: 'session_meta', padding: 'x'.repeat(200_000) })
    await writeFile(file, jsonl([long, record(2)]))
    expect(await readFirstLine(gate, file)).toMatchObject({ kind: 'line', line: long })
  })

  it('stops at the cap when the first line is longer', async () => {
    const huge = JSON.stringify({ type: 'session_meta', padding: 'x'.repeat(FIRST_LINE_MAX_BYTES) })
    await writeFile(file, jsonl([huge, record(2)]))
    expect(await readFirstLine(gate, file)).toEqual({
      kind: 'too-long',
      bytesRead: FIRST_LINE_MAX_BYTES
    })
    expect(await readFirstLine(gate, file, 1000)).toEqual({ kind: 'too-long', bytesRead: 1000 })
  })
})

describe('readLastLines', () => {
  it('returns the last lines, oldest first', async () => {
    await writeFile(file, jsonl(records(1, 100)))
    const result = await readLastLines(gate, file, { maxLines: 3, maxBytes: 1024 * 1024 })
    expect(result.lines).toEqual(records(98, 100))
    expect(result.reachedStart).toBe(false)
  })

  it('returns every line of a short file and says it reached the start', async () => {
    await writeFile(file, jsonl(records(1, 5)))
    const result = await readLastLines(gate, file, BIG)
    expect(result.lines).toEqual(records(1, 5))
    expect(result.reachedStart).toBe(true)
  })

  it('handles an empty file', async () => {
    await writeFile(file, '')
    const result = await readLastLines(gate, file, BIG)
    expect(result).toMatchObject({ lines: [], reachedStart: true, bytesRead: 0 })
    expect(result.cursor).toMatchObject({ offset: 0, insideSkippedLine: false })
  })

  it('removes CRLF line endings, and skips blank lines without counting them', async () => {
    await writeFile(file, `${record(1)}\r\n${record(2)}\r\n\r\n   \n\n${record(3)}\r\n\n`)
    const result = await readLastLines(gate, file, { maxLines: 2, maxBytes: 1024 })
    expect(result.lines).toEqual([record(2), record(3)])
  })

  it('holds back an unfinished last line and puts the cursor at its start', async () => {
    const complete = jsonl(records(1, 3))
    await writeFile(file, `${complete}{"type":"synth`)
    const result = await readLastLines(gate, file, BIG)
    expect(result.lines).toEqual(records(1, 3))
    expect(result.cursor).toMatchObject({
      offset: Buffer.byteLength(complete),
      insideSkippedLine: false
    })
  })

  it('reads the tail of a 20 MB file without reading the whole file', async () => {
    // About 20 MB of 1 KB records.
    const padding = 'x'.repeat(1000)
    const lines = Array.from({ length: 20_000 }, (_, n) => JSON.stringify({ n, padding }))
    const content = jsonl(lines)
    await writeFile(file, content)
    expect(Buffer.byteLength(content)).toBeGreaterThan(20_000_000)

    const result = await readLastLines(gate, file, { maxLines: 20, maxBytes: 1024 * 1024 })
    expect(result.lines).toEqual(lines.slice(-20))
    expect(result.bytesRead).toBe(64 * 1024)
    expect(result.cursor.offset).toBe(Buffer.byteLength(content))
  })

  it('stays within the byte budget when the lines it wants are older', async () => {
    const padding = 'x'.repeat(1000)
    await writeFile(
      file,
      jsonl(Array.from({ length: 5000 }, (_, n) => JSON.stringify({ n, padding })))
    )
    const result = await readLastLines(gate, file, { maxLines: 4000, maxBytes: 200_000 })
    expect(result.bytesRead).toBe(200_000)
    expect(result.lines.length).toBeLessThan(200)
    expect(result.reachedStart).toBe(false)
  })

  it('decodes multi-byte characters that cross a chunk boundary', async () => {
    // Shift the text so that its multi-byte characters straddle the 64 KiB boundary from the end.
    const text = 'Xin chào thế giới 🌏 '.repeat(200)
    const target = JSON.stringify({ type: 'synthetic', text })
    const filler = JSON.stringify({ type: 'synthetic', padding: 'y'.repeat(70_000) })
    for (const shift of [0, 1, 2, 3]) {
      const tail = jsonl([target, 'z'.repeat(64 * 1024 - 2000 + shift)])
      await writeFile(file, jsonl([filler]) + tail)
      const result = await readLastLines(gate, file, { maxLines: 2, maxBytes: 1024 * 1024 })
      expect(result.lines[0]).toBe(target)
    }
  })

  it('leaves out a last line longer than the budget and skips its rest later', async () => {
    const huge = `{"type":"synthetic","padding":"${'x'.repeat(300_000)}`
    await writeFile(file, jsonl(records(1, 3)) + huge)
    const tail = await readLastLines(gate, file, { maxLines: 10, maxBytes: 100_000 })
    expect(tail.lines).toEqual([])
    expect(tail.bytesRead).toBe(100_000)
    expect(tail.cursor).toMatchObject({ insideSkippedLine: true })

    // The huge line ends, and new lines follow: only the new lines come back.
    await appendFile(file, `"}\n${jsonl(records(4, 5))}`)
    const next = newLines(await readNewLines(gate, file, tail.cursor, { maxBytes: 1024 * 1024 }))
    expect(next.lines).toEqual(records(4, 5))
    expect(next.cursor).toMatchObject({ insideSkippedLine: false })
  })

  it('leaves out a complete line longer than the budget', async () => {
    const huge = JSON.stringify({ type: 'synthetic', padding: 'x'.repeat(300_000) })
    await writeFile(file, jsonl([record(1), huge]))
    const result = await readLastLines(gate, file, { maxLines: 10, maxBytes: 100_000 })
    expect(result.lines).toEqual([])
    expect(result.cursor).toMatchObject({ insideSkippedLine: false })
  })
})

describe('readNewLines', () => {
  const OPTIONS = { maxBytes: 1024 * 1024 }

  async function startAtEnd(content: string): Promise<JsonlCursor> {
    await writeFile(file, content)
    return (await readLastLines(gate, file, BIG)).cursor
  }

  it('returns only the lines added since the cursor', async () => {
    const cursor = await startAtEnd(jsonl(records(1, 3)))
    await appendFile(file, jsonl(records(4, 5)))
    const result = newLines(await readNewLines(gate, file, cursor, OPTIONS))
    expect(result.lines).toEqual(records(4, 5))

    await appendFile(file, jsonl([record(6)]))
    expect(newLines(await readNewLines(gate, file, result.cursor, OPTIONS)).lines).toEqual([
      record(6)
    ])
  })

  it('reads nothing when nothing was added', async () => {
    const cursor = await startAtEnd(jsonl(records(1, 3)))
    expect(await readNewLines(gate, file, cursor, OPTIONS)).toEqual({
      kind: 'lines',
      lines: [],
      cursor,
      bytesRead: 0
    })
  })

  it('holds a partial write until its line ends', async () => {
    const cursor = await startAtEnd(jsonl(records(1, 2)))
    await appendFile(file, '{"type":"synthetic",')
    const first = newLines(await readNewLines(gate, file, cursor, OPTIONS))
    expect(first.lines).toEqual([])
    expect(first.cursor.offset).toBe(cursor.offset)

    await appendFile(file, `"n":3}\r\n${record(4)}\n{"type"`)
    const second = newLines(await readNewLines(gate, file, first.cursor, OPTIONS))
    expect(second.lines).toEqual(['{"type":"synthetic","n":3}', record(4)])
  })

  it('reads from the start of a file that had no complete line', async () => {
    const cursor = await startAtEnd('{"type":"synth')
    expect(cursor.offset).toBe(0)
    await appendFile(file, `etic","n":1}\n`)
    expect(newLines(await readNewLines(gate, file, cursor, OPTIONS)).lines).toEqual([
      '{"type":"synthetic","n":1}'
    ])
  })

  it('skips blank lines', async () => {
    const cursor = await startAtEnd(jsonl([record(1)]))
    await appendFile(file, `\n \n${record(2)}\n\n`)
    expect(newLines(await readNewLines(gate, file, cursor, OPTIONS)).lines).toEqual([record(2)])
  })

  it('resets when the file is truncated', async () => {
    const cursor = await startAtEnd(jsonl(records(1, 5)))
    await truncate(file, 10)
    expect(await readNewLines(gate, file, cursor, OPTIONS)).toMatchObject({
      kind: 'reset',
      reason: 'truncated'
    })
  })

  it('resets when the file is replaced by another one', async () => {
    const cursor = await startAtEnd(jsonl(records(1, 2)))
    const replacement = `${file}.new`
    await writeFile(replacement, jsonl(records(1, 4)))
    await rename(replacement, file)
    expect(await readNewLines(gate, file, cursor, OPTIONS)).toMatchObject({
      kind: 'reset',
      reason: 'replaced'
    })
  })

  it('resets when the file was rewritten in place', async () => {
    const cursor = await startAtEnd(jsonl(records(1, 2)))
    // Same file, longer content, but the byte before the cursor is no longer a line end.
    await writeFile(file, jsonl([JSON.stringify({ type: 'synthetic', padding: 'x'.repeat(50) })]))
    expect(await readNewLines(gate, file, cursor, OPTIONS)).toMatchObject({
      kind: 'reset',
      reason: 'rewritten'
    })
  })

  it('resets instead of reading more than the budget', async () => {
    const cursor = await startAtEnd(jsonl([record(1)]))
    await appendFile(file, jsonl(records(2, 2000)))
    expect(await readNewLines(gate, file, cursor, { maxBytes: 1000 })).toEqual({
      kind: 'reset',
      reason: 'too-far-behind',
      bytesRead: 0
    })
  })

  it('stays inside a skipped line until it ends', async () => {
    await writeFile(file, `{"padding":"${'x'.repeat(5000)}`)
    const tail = await readLastLines(gate, file, { maxLines: 10, maxBytes: 1000 })
    expect(tail.cursor).toMatchObject({ insideSkippedLine: true })

    await appendFile(file, 'x'.repeat(500))
    const still = newLines(await readNewLines(gate, file, tail.cursor, OPTIONS))
    expect(still.lines).toEqual([])
    expect(still.cursor).toMatchObject({ insideSkippedLine: true })

    await appendFile(file, `"}\n${record(1)}\n`)
    expect(newLines(await readNewLines(gate, file, still.cursor, OPTIONS)).lines).toEqual([
      record(1)
    ])
  })
})

describe('the reader and the access gate', () => {
  it('refuses a path outside the allowlist before reading anything', async () => {
    const key = join(home, '.claude', 'sessions', '12345.abcdef.key')
    await mkdir(join(home, '.claude', 'sessions'), { recursive: true })
    await writeFile(key, 'secret\n')
    const cursor: JsonlCursor = { fileId: '0:0', offset: 0, insideSkippedLine: false }
    const refused = { name: 'AccessRefusedError', reason: 'credential' }
    await expect(readFirstLine(gate, key)).rejects.toMatchObject(refused)
    await expect(readLastLines(gate, key, BIG)).rejects.toMatchObject(refused)
    await expect(readNewLines(gate, key, cursor, { maxBytes: 1000 })).rejects.toMatchObject(refused)
  })
})
