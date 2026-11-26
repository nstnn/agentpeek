import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type AccessGate, createAccessGate } from './access'
import { antigravityPaths } from './antigravity-files'
import {
  applyWal,
  createAntigravityWorkspaces,
  workspaceFolder,
  workspaceRows
} from './antigravity-workspaces'

// Synthetic databases only, shaped like Antigravity Desktop's `conversation_summaries.db`
// (observed schema, 2026-11-26), in a temporary folder that stands in for the home folder.

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

let root: string
let home: string
let paths: ReturnType<typeof antigravityPaths>
let opened: string[]
let gate: AccessGate
let clock: number

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agentpeek-antigravity-workspaces-'))
  home = join(root, 'home')
  paths = antigravityPaths(home)
  await mkdir(join(home, '.gemini', 'antigravity'), { recursive: true })
  const realGate = createAccessGate(home)
  opened = []
  gate = {
    resolve: (path) => realGate.resolve(path),
    open: (path) => {
      opened.push(path)
      return realGate.open(path)
    }
  }
  clock = 1_800_000_000_000
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** Writes a synthetic summaries database in WAL mode, as Antigravity does, and closes it. */
function writeDatabase(rows: readonly [string, string][], path = paths.summaries): void {
  const database = new DatabaseSync(path)
  database.exec('PRAGMA journal_mode=WAL')
  database.exec(`CREATE TABLE IF NOT EXISTS conversation_summaries (
    conversation_id text PRIMARY KEY, title text NOT NULL DEFAULT '',
    preview text NOT NULL DEFAULT '', workspace_uris text NOT NULL, raw_summary blob)`)
  database.exec('DELETE FROM conversation_summaries')
  const insert = database.prepare(
    'INSERT INTO conversation_summaries (conversation_id, title, preview, workspace_uris) VALUES (?, ?, ?, ?)'
  )
  for (const [id, uris] of rows) insert.run(id, 'Synthetic title', 'Synthetic preview', uris)
  database.close()
}

function bytesOf(path = paths.summaries): Promise<Buffer> {
  return readFile(path)
}

describe('workspaceFolder', () => {
  it('takes the first file URI as a normalized absolute path', () => {
    expect(workspaceFolder('["file:///Users/synthetic/app"]')).toBe('/Users/synthetic/app')
    expect(workspaceFolder('["file:///Users/synthetic/app/"]')).toBe('/Users/synthetic/app')
    expect(workspaceFolder('["file:///Users/synthetic/my%20app"]')).toBe('/Users/synthetic/my app')
    expect(workspaceFolder('["https://example.invalid/x", "file:///Users/synthetic/b"]')).toBe(
      '/Users/synthetic/b'
    )
    expect(workspaceFolder('["file:///"]')).toBe('/')
    // Dot segments resolve as in any URL.
    expect(workspaceFolder('["file:///Users/synthetic/../other"]')).toBe('/Users/other')
  })

  it('gives no folder for anything else', () => {
    for (const value of [
      '[]',
      '',
      'not json',
      '{"uri": "file:///Users/synthetic/app"}',
      '[42]',
      '["file://host/share"]',
      '["file:///Users/synthetic/a%00b"]',
      `["file:///${'a'.repeat(5000)}"]`,
      null,
      42
    ]) {
      expect(workspaceFolder(value)).toBeNull()
    }
  })
})

describe('workspaceRows', () => {
  it('reads each conversation folder from an in-memory copy and skips malformed IDs', async () => {
    writeDatabase([
      [ID(1), '["file:///Users/synthetic/app"]'],
      [ID(2), '[]'],
      ['not-a-uuid', '["file:///Users/synthetic/other"]'],
      ['ABCDEF00-0000-4000-8000-000000000003', '["file:///Users/synthetic/upper"]']
    ])
    const bytes = await bytesOf()
    // Antigravity's file says WAL mode (header bytes 18 and 19 are 2).
    expect([bytes[18], bytes[19]]).toEqual([2, 2])
    const rows = workspaceRows(bytes)
    expect([...rows]).toEqual([
      [ID(1), '/Users/synthetic/app'],
      [ID(2), null]
    ])
    // The caller's buffer is not changed.
    expect([bytes[18], bytes[19]]).toEqual([2, 2])
  })

  it('throws when the table is missing', () => {
    const database = new DatabaseSync(paths.summaries)
    database.exec('CREATE TABLE other (conversation_id text, workspace_uris text)')
    database.close()
    expect(() => workspaceRows(readFileSync(paths.summaries))).toThrow()
  })
})

/**
 * Opens a synthetic database in WAL mode with checkpoints off, as Antigravity leaves it while it
 * runs: committed rows stay in `-wal` until the connection closes.
 */
function openLiveDatabase(): DatabaseSync {
  writeDatabase([[ID(1), '["file:///Users/synthetic/app"]']])
  const database = new DatabaseSync(paths.summaries)
  database.exec('PRAGMA wal_autocheckpoint=0')
  database
    .prepare('INSERT INTO conversation_summaries (conversation_id, workspace_uris) VALUES (?, ?)')
    .run(ID(2), '["file:///Users/synthetic/new"]')
  return database
}

describe('applyWal', () => {
  it('applies committed frames, ignoring a torn last frame and an invalid WAL', async () => {
    const live = openLiveDatabase()
    try {
      const database = await bytesOf()
      const wal = await bytesOf(`${paths.summaries}-wal`)
      expect(workspaceRows(database).has(ID(2))).toBe(false)
      expect(workspaceRows(applyWal(database, wal)).get(ID(2))).toBe('/Users/synthetic/new')

      // A later transaction cut short in the middle of its frame is ignored.
      live
        .prepare(
          'INSERT INTO conversation_summaries (conversation_id, workspace_uris) VALUES (?, ?)'
        )
        .run(ID(3), '["file:///Users/synthetic/later"]')
      const longer = await bytesOf(`${paths.summaries}-wal`)
      const torn = longer.subarray(0, wal.length + 100)
      const rows = workspaceRows(applyWal(database, torn))
      expect(rows.get(ID(2))).toBe('/Users/synthetic/new')
      expect(rows.has(ID(3))).toBe(false)
      expect(workspaceRows(applyWal(database, longer)).get(ID(3))).toBe('/Users/synthetic/later')

      // A damaged page fails its checksum, so that frame and every later one are ignored.
      const damaged = Buffer.from(wal)
      damaged[32 + 24 + 10] = (damaged[32 + 24 + 10] ?? 0) ^ 0xff
      expect(applyWal(database, damaged)).toBe(database)
      expect(applyWal(database, Buffer.alloc(64))).toBe(database)
      expect(applyWal(database, wal.subarray(0, 16))).toBe(database)
    } finally {
      live.close()
    }
  })
})

describe('createAntigravityWorkspaces', () => {
  it('reads rows still in the WAL while Antigravity holds the database open', async () => {
    const live = openLiveDatabase()
    try {
      const workspaces = createAntigravityWorkspaces({
        gate,
        path: paths.summaries,
        now: () => clock
      })
      await workspaces.update([ID(1), ID(2)])
      expect(workspaces.get(ID(1))).toBe('/Users/synthetic/app')
      expect(workspaces.get(ID(2))).toBe('/Users/synthetic/new')
      expect(opened).toEqual([paths.summaries, `${paths.summaries}-wal`])
    } finally {
      live.close()
    }
  })

  function create() {
    return createAntigravityWorkspaces({ gate, path: paths.summaries, now: () => clock })
  }

  it('gives folders through the gate and leaves the tool file and its folder unchanged', async () => {
    writeDatabase([[ID(1), '["file:///Users/synthetic/app"]']])
    const before = await bytesOf()
    const beforeStat = await stat(paths.summaries)
    const beforeNames = await readdir(join(home, '.gemini', 'antigravity'))

    const workspaces = create()
    await workspaces.update([ID(1), ID(2)])
    expect(workspaces.get(ID(1))).toBe('/Users/synthetic/app')
    expect(workspaces.get(ID(2))).toBeNull()
    expect(opened).toEqual([paths.summaries])

    expect((await bytesOf()).equals(before)).toBe(true)
    expect((await stat(paths.summaries)).mtimeMs).toBe(beforeStat.mtimeMs)
    // No journal, `-wal` or `-shm` file appears beside it.
    expect(await readdir(join(home, '.gemini', 'antigravity'))).toEqual(beforeNames)
  })

  it('rereads a changed database at most every 5 seconds for a missing row, once a minute otherwise', async () => {
    writeDatabase([[ID(1), '["file:///Users/synthetic/app"]']])
    const workspaces = create()
    await workspaces.update([ID(1)])
    expect(opened).toHaveLength(1)

    // Unchanged: no reread.
    clock += 120_000
    await workspaces.update([ID(1)])
    expect(opened).toHaveLength(1)

    // Changed, every row known: reread only after a minute.
    writeDatabase([[ID(1), '["file:///Users/synthetic/moved"]']])
    await workspaces.update([ID(1)])
    expect(opened).toHaveLength(2)
    expect(workspaces.get(ID(1))).toBe('/Users/synthetic/moved')
    writeDatabase([[ID(1), '["file:///Users/synthetic/app"]']])
    clock += 30_000
    await workspaces.update([ID(1)])
    expect(opened).toHaveLength(2)
    expect(workspaces.get(ID(1))).toBe('/Users/synthetic/moved')
    clock += 30_000
    await workspaces.update([ID(1)])
    expect(opened).toHaveLength(3)
    expect(workspaces.get(ID(1))).toBe('/Users/synthetic/app')

    // A listed conversation without a row: reread after 5 seconds.
    writeDatabase([
      [ID(1), '["file:///Users/synthetic/app"]'],
      [ID(2), '["file:///Users/synthetic/new"]']
    ])
    clock += 1000
    await workspaces.update([ID(1), ID(2)])
    expect(opened).toHaveLength(3)
    clock += 4000
    await workspaces.update([ID(1), ID(2)])
    expect(opened).toHaveLength(4)
    expect(workspaces.get(ID(2))).toBe('/Users/synthetic/new')
  })

  it('keeps the last folders when the database cannot be read, and forgets them when it is gone', async () => {
    writeDatabase([[ID(1), '["file:///Users/synthetic/app"]']])
    const workspaces = create()
    await workspaces.update([ID(1)])
    await writeFile(
      paths.summaries,
      'not a database, but long enough to pass the size check'.repeat(4)
    )
    clock += 120_000
    await workspaces.update([ID(1)])
    expect(workspaces.get(ID(1))).toBe('/Users/synthetic/app')

    await rm(paths.summaries)
    await workspaces.update([ID(1)])
    expect(workspaces.get(ID(1))).toBeNull()
  })

  it('never opens a database through a symlink that leads elsewhere', async () => {
    const outside = join(root, 'outside.db')
    writeDatabase([[ID(1), '["file:///Users/synthetic/app"]']], outside)
    await symlink(outside, paths.summaries)
    const workspaces = create()
    await workspaces.update([ID(1)])
    expect(workspaces.get(ID(1))).toBeNull()
  })
})
