import { execFileSync } from 'node:child_process'
import {
  mkdir,
  mkdtemp,
  open as openFile,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_LOCAL_STATE, type SessionKey } from '../../core/session'
import type { AgentTool } from '../../core/tools'
import { parseStateFile, serializeStateFile, type StoredSession } from './state-file'
import {
  FORGET_AFTER_MS,
  MAX_STATE_FILE_BYTES,
  openStateStore,
  STATE_FILE_NAME,
  STATE_TEMP_FILE_NAME,
  STATE_WRITE_DELAY_MS,
  type StateStore
} from './state-store'

// The rename spy counts saves (each ends with one rename) and can make one fail. The open spy lets a
// test watch the file handle the store reads from.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, open: vi.fn(actual.open), rename: vi.fn(actual.rename) }
})

// Synthetic IDs and times only, in a temporary folder that stands in for AgentPeek's own folder.
const DAY = 24 * 60 * 60 * 1000
const CODEX: SessionKey = { tool: 'codex', id: '00000000-0000-4000-8000-0000000000a1' }
const CLAUDE: SessionKey = { tool: 'claude', id: '00000000-0000-4000-8000-0000000000c1' }
const REPLY = '00000000-0000-4000-8000-0000000000b1'
const ERROR = '00000000-0000-4000-8000-0000000000e1'

let root: string
let folder: string
let file: string
let clock: number

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agentpeek-state-'))
  folder = join(root, 'AgentPeek')
  file = join(folder, STATE_FILE_NAME)
  clock = 1_768_467_600_000
  vi.mocked(rename).mockClear()
  vi.mocked(openFile).mockClear()
})

afterEach(async () => {
  vi.useRealTimers()
  await rm(root, { recursive: true, force: true })
})

function open(): Promise<StateStore> {
  return openStateStore({ folder, now: () => clock })
}

function stored(key: SessionKey, change: Partial<StoredSession> = {}): StoredSession {
  return {
    ...key,
    pinned: true,
    seenCursor: null,
    acknowledgedErrorCursor: null,
    lastListedAt: clock,
    ...change
  }
}

async function writeState(sessions: StoredSession[], baselines = {}): Promise<void> {
  await mkdir(folder, { recursive: true })
  await writeFile(file, serializeStateFile({ baselines, sessions }))
}

async function readState(): Promise<ReturnType<typeof parseStateFile>> {
  return parseStateFile(await readFile(file, 'utf8'))
}

describe('a fresh start', () => {
  it('starts empty and writes nothing until something changes', async () => {
    const store = await open()
    expect(store.status()).toEqual({ kind: 'available' })
    expect(store.localState(CODEX)).toEqual(EMPTY_LOCAL_STATE)
    expect(store.baseline('codex')).toBeUndefined()
    await store.flush()
    expect(await readdir(root)).toEqual([])
  })

  it('creates the folder and the file, and reads them back after a reopen', async () => {
    const store = await open()
    store.setBaseline('codex', clock)
    store.setLocalState(CODEX, { pinned: true, seenCursor: REPLY, acknowledgedErrorCursor: null })
    store.setLocalState(CLAUDE, { pinned: false, seenCursor: null, acknowledgedErrorCursor: ERROR })
    await store.flush()

    // Nothing outside the folder, and nothing in it but the file.
    expect(await readdir(root)).toEqual(['AgentPeek'])
    expect(await readdir(folder)).toEqual([STATE_FILE_NAME])
    expect((await stat(file)).mode & 0o777).toBe(0o600)

    const reopened = await open()
    expect(reopened.status()).toEqual({ kind: 'available' })
    expect(reopened.baseline('codex')).toBe(clock)
    expect(reopened.baseline('claude')).toBeUndefined()
    expect(reopened.localState(CODEX)).toEqual({
      pinned: true,
      seenCursor: REPLY,
      acknowledgedErrorCursor: null
    })
    expect(reopened.localState(CLAUDE)).toEqual({
      pinned: false,
      seenCursor: null,
      acknowledgedErrorCursor: ERROR
    })
  })

  it('removes an entry set back to the empty state', async () => {
    const store = await open()
    store.setLocalState(CODEX, { ...EMPTY_LOCAL_STATE, pinned: true })
    store.setLocalState(CODEX, EMPTY_LOCAL_STATE)
    await store.flush()
    expect(await readState()).toEqual({ kind: 'state', data: { baselines: {}, sessions: [] } })
  })
})

describe('saving', () => {
  it('coalesces rapid changes into one save', async () => {
    const store = await open()
    for (let index = 0; index < 20; index += 1) {
      store.setLocalState(CODEX, { ...EMPTY_LOCAL_STATE, pinned: index % 2 === 0 })
    }
    await store.flush()
    expect(rename).toHaveBeenCalledTimes(1)
    expect(store.localState(CODEX).pinned).toBe(false)
    expect(await readState()).toEqual({ kind: 'state', data: { baselines: {}, sessions: [] } })

    // Nothing changed since, so nothing is saved.
    await store.flush()
    expect(rename).toHaveBeenCalledTimes(1)
  })

  it('saves on its own after the delay', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const store = await open()
    store.setLocalState(CODEX, { ...EMPTY_LOCAL_STATE, pinned: true })
    await vi.advanceTimersByTimeAsync(STATE_WRITE_DELAY_MS - 1)
    store.setLocalState(CLAUDE, { ...EMPTY_LOCAL_STATE, pinned: true })
    expect(rename).not.toHaveBeenCalled()

    // The second change joined the save the first one scheduled, without pushing it back.
    await vi.advanceTimersByTimeAsync(1)
    expect(vi.getTimerCount()).toBe(0)
    await vi.waitFor(() => expect(rename).toHaveBeenCalledTimes(1))
    const saved = await readState()
    expect(saved.kind === 'state' && saved.data.sessions.map((session) => session.tool)).toEqual([
      'codex',
      'claude'
    ])
  })

  it('does not save a change that changes nothing', async () => {
    await writeState([stored(CODEX)], { codex: clock })
    const store = await open()
    store.setLocalState(CODEX, { ...EMPTY_LOCAL_STATE, pinned: true })
    store.setBaseline('codex', clock)
    store.setLocalState(CLAUDE, EMPTY_LOCAL_STATE)
    await store.flush()
    expect(rename).not.toHaveBeenCalled()
  })

  it('refuses an ID or a cursor that could be message text, and stores nothing', async () => {
    const store = await open()
    const text = 'Synthetic reply: the folder holds two files.'
    expect(() => store.setLocalState(CODEX, { ...EMPTY_LOCAL_STATE, seenCursor: text })).toThrow(
      TypeError
    )
    expect(() =>
      store.setLocalState(CODEX, { ...EMPTY_LOCAL_STATE, acknowledgedErrorCursor: text })
    ).toThrow(TypeError)
    expect(() =>
      store.setLocalState({ tool: 'codex', id: text }, { ...EMPTY_LOCAL_STATE, pinned: true })
    ).toThrow(TypeError)
    // A cast or an IPC argument can carry text where a flag belongs.
    expect(() =>
      store.setLocalState(CODEX, { ...EMPTY_LOCAL_STATE, pinned: text as unknown as boolean })
    ).toThrow(TypeError)
    expect(() => store.setBaseline('codex', Number.NaN)).toThrow(TypeError)
    await store.flush()
    expect(store.localState(CODEX)).toEqual(EMPTY_LOCAL_STATE)
    expect(await readdir(root)).toEqual([])
  })

  it('refuses a tool it does not know, which could carry text past the type system', async () => {
    const store = await open()
    // An IPC argument or a cast can carry any string at run time.
    const tool = 'Synthetic reply: the folder holds two files.' as AgentTool
    expect(() =>
      store.setLocalState({ tool, id: CODEX.id }, { ...EMPTY_LOCAL_STATE, pinned: true })
    ).toThrow(TypeError)
    expect(() => store.setBaseline(tool, clock)).toThrow(TypeError)
    await store.flush()
    expect(store.baseline(tool)).toBeUndefined()
    expect(await readdir(root)).toEqual([])
  })

  it('never saves a state too large to read back, and saves again once it shrinks', async () => {
    await writeState([stored(CODEX)])
    const original = await readFile(file)
    const store = await open()
    // Entries with the longest IDs and cursors allowed, about 750 bytes each: past the read cap.
    const long = (prefix: string, index: number): string =>
      `${prefix}${String(index).padStart(10, '0')}`.padEnd(200, 'x')
    const keys: SessionKey[] = []
    for (let index = 0; index < 6000; index += 1) {
      const key: SessionKey = { tool: 'claude', id: long('id-', index) }
      keys.push(key)
      store.setLocalState(key, {
        pinned: false,
        seenCursor: long('seen-', index),
        acknowledgedErrorCursor: long('error-', index)
      })
    }
    await store.flush()
    expect(store.status()).toEqual({ kind: 'unavailable', reason: 'unwritable' })
    expect(rename).not.toHaveBeenCalled()
    expect(await readFile(file)).toEqual(original)
    expect(await readdir(folder)).toEqual([STATE_FILE_NAME])

    for (const key of keys) store.setLocalState(key, EMPTY_LOCAL_STATE)
    await store.flush()
    expect(store.status()).toEqual({ kind: 'available' })
    const reopened = await open()
    expect(reopened.status()).toEqual({ kind: 'available' })
    expect(reopened.localState(CODEX).pinned).toBe(true)
  })
})

describe('an interrupted save', () => {
  it('leaves the temporary file and the original intact, and tries again later', async () => {
    await writeState([stored(CODEX)])
    const original = await readFile(file)
    const store = await open()
    store.setLocalState(CLAUDE, { ...EMPTY_LOCAL_STATE, pinned: true })

    // The process "stops" between writing the temporary file and renaming it.
    vi.mocked(rename).mockRejectedValueOnce(new Error('interrupted'))
    await store.flush()
    expect(store.status()).toEqual({ kind: 'unavailable', reason: 'unwritable' })
    expect(await readFile(file)).toEqual(original)
    expect((await readdir(folder)).sort()).toEqual([STATE_FILE_NAME, STATE_TEMP_FILE_NAME])

    // A reopen reads the original and ignores the temporary file.
    const reopened = await open()
    expect(reopened.status()).toEqual({ kind: 'available' })
    expect(reopened.localState(CLAUDE)).toEqual(EMPTY_LOCAL_STATE)

    // The next save replaces the temporary file and succeeds.
    await store.flush()
    expect(store.status()).toEqual({ kind: 'available' })
    expect(await readdir(folder)).toEqual([STATE_FILE_NAME])
    expect((await open()).localState(CLAUDE).pinned).toBe(true)
  })

  it('ignores a leftover temporary file with damaged contents, and replaces all of it', async () => {
    await writeState([stored(CODEX)])
    // Longer than the next save, so a save that only overwrote its start would leave a tail.
    await writeFile(join(folder, STATE_TEMP_FILE_NAME), `{"version":1,"sess${' '.repeat(10_000)}x`)
    const store = await open()
    expect(store.status()).toEqual({ kind: 'available' })
    expect(store.localState(CODEX).pinned).toBe(true)
    store.setLocalState(CLAUDE, { ...EMPTY_LOCAL_STATE, pinned: true })
    await store.flush()
    expect(await readdir(folder)).toEqual([STATE_FILE_NAME])
    expect(await readFile(file, 'utf8')).toBe(
      serializeStateFile({ baselines: {}, sessions: [stored(CODEX), stored(CLAUDE)] })
    )
  })

  it('never writes through a symlink in the temporary file’s place', async () => {
    const outside = join(root, 'outside.json')
    await writeFile(outside, 'outside')
    await mkdir(folder)
    await symlink(outside, join(folder, STATE_TEMP_FILE_NAME))
    const store = await open()
    store.setLocalState(CODEX, { ...EMPTY_LOCAL_STATE, pinned: true })
    await store.flush()
    expect(store.status()).toEqual({ kind: 'unavailable', reason: 'unwritable' })
    expect(await readFile(outside, 'utf8')).toBe('outside')
    expect(rename).not.toHaveBeenCalled()
  })
})

describe('a file AgentPeek cannot use', () => {
  async function expectUnchangedAfterChanges(
    reason: 'newer-version' | 'unreadable'
  ): Promise<void> {
    const before = await readFile(file)
    const { mtimeMs } = await stat(file)
    const store = await open()
    expect(store.status()).toEqual({ kind: 'unavailable', reason })

    // Changes still work, in memory only.
    expect(store.baseline('codex')).toBeUndefined()
    store.setBaseline('codex', clock)
    store.setLocalState(CODEX, { pinned: true, seenCursor: REPLY, acknowledgedErrorCursor: null })
    expect(store.localState(CODEX)).toEqual({
      pinned: true,
      seenCursor: REPLY,
      acknowledgedErrorCursor: null
    })
    expect(store.baseline('codex')).toBe(clock)
    await store.flush()

    expect(rename).not.toHaveBeenCalled()
    // Buffer.equals: a deep comparison of a 4 MiB buffer would take seconds.
    expect((await readFile(file)).equals(before)).toBe(true)
    expect((await stat(file)).mtimeMs).toBe(mtimeMs)
    expect(await readdir(folder)).toEqual([STATE_FILE_NAME])
  }

  it('leaves a newer version byte-for-byte unchanged', async () => {
    await mkdir(folder)
    await writeFile(file, '{"version":2,"pins":["00000000-0000-4000-8000-0000000000a1"]}\n')
    await expectUnchangedAfterChanges('newer-version')
  })

  it('leaves a damaged file byte-for-byte unchanged', async () => {
    await mkdir(folder)
    await writeFile(file, '{"version":1,"baselines":{},"sessions":[{"tool":"codex"')
    await expectUnchangedAfterChanges('unreadable')
  })

  it('leaves a valid file it may not open byte-for-byte unchanged', async () => {
    await writeState([stored(CODEX)])
    // The file is there, but opening it fails, as with permissions that shut AgentPeek out. Only
    // a missing file may count as a fresh start; anything else must never be overwritten.
    vi.mocked(openFile).mockRejectedValueOnce(
      Object.assign(new Error('Permission denied.'), { code: 'EACCES' })
    )
    await expectUnchangedAfterChanges('unreadable')
  })

  it('does not read a file over the size cap', async () => {
    // A valid file, padded with spaces past the cap.
    await writeState([stored(CODEX)])
    const valid = await readFile(file, 'utf8')
    await writeFile(file, valid.padEnd(MAX_STATE_FILE_BYTES + 1))
    await expectUnchangedAfterChanges('unreadable')
  })

  it('reports a folder in the file’s place as unreadable', async () => {
    await mkdir(file, { recursive: true })
    const store = await open()
    expect(store.status()).toEqual({ kind: 'unavailable', reason: 'unreadable' })
    store.setLocalState(CODEX, { ...EMPTY_LOCAL_STATE, pinned: true })
    await store.flush()
    expect(rename).not.toHaveBeenCalled()
  })

  it('reports a named pipe in the file’s place as unreadable, without waiting for a writer', async () => {
    await mkdir(folder)
    execFileSync('/usr/bin/mkfifo', [file])
    const store = await open()
    expect(store.status()).toEqual({ kind: 'unavailable', reason: 'unreadable' })
  })

  it('never reads a device in the file’s place', async () => {
    await mkdir(folder)
    await symlink('/dev/null', file)
    // The stub stands in for a device that never ends, such as /dev/zero, and answers with a
    // valid file, so only the file-type check can make the store report it as unreadable.
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    let readFromDevice = false
    vi.mocked(openFile).mockImplementationOnce(async (path, flags) => {
      const handle = await actual.open(path, flags)
      vi.spyOn(handle, 'readFile').mockImplementation(() => {
        readFromDevice = true
        return Promise.resolve(serializeStateFile({ baselines: {}, sessions: [] }))
      })
      return handle
    })
    const store = await open()
    expect(store.status()).toEqual({ kind: 'unavailable', reason: 'unreadable' })
    expect(readFromDevice).toBe(false)
  })
})

describe('forgetting old sessions', () => {
  it('drops sessions not listed for 90 days when it opens, and saves that', async () => {
    await writeState(
      [
        stored(CODEX, { lastListedAt: clock - FORGET_AFTER_MS - 1 }),
        stored(CLAUDE, { lastListedAt: clock - FORGET_AFTER_MS })
      ],
      { codex: clock - 200 * DAY }
    )
    const store = await open()
    expect(store.localState(CODEX)).toEqual(EMPTY_LOCAL_STATE)
    expect(store.localState(CLAUDE).pinned).toBe(true)
    // Baselines are never dropped.
    expect(store.baseline('codex')).toBe(clock - 200 * DAY)

    await store.flush()
    const saved = await readState()
    expect(saved.kind === 'state' && saved.data.sessions.map((session) => session.id)).toEqual([
      CLAUDE.id
    ])
  })

  it('keeps a listed session by moving its listed time forward, at most once a day', async () => {
    await writeState([stored(CODEX), stored(CLAUDE)])
    const store = await open()

    clock += DAY - 1
    store.noteListed([CODEX, CLAUDE])
    await store.flush()
    expect(rename).not.toHaveBeenCalled()

    clock += 1
    store.noteListed([CODEX, { tool: 'codex', id: '00000000-0000-4000-8000-0000000000a9' }])
    await store.flush()
    expect(rename).toHaveBeenCalledTimes(1)
    const saved = await readState()
    expect(saved.kind === 'state' && saved.data.sessions).toEqual([
      stored(CODEX, { lastListedAt: clock }),
      stored(CLAUDE, { lastListedAt: clock - DAY })
    ])
  })

  it('counts a change the user makes as a listing', async () => {
    await writeState([stored(CODEX, { lastListedAt: clock - 80 * DAY })])
    const store = await open()
    clock += 20 * DAY
    store.setLocalState(CODEX, { pinned: true, seenCursor: REPLY, acknowledgedErrorCursor: null })
    await store.flush()
    expect((await open()).localState(CODEX).seenCursor).toBe(REPLY)
  })
})
