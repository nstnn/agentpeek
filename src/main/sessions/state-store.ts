import { constants, mkdir, open, rename } from 'node:fs/promises'
import { join } from 'node:path'
import {
  EMPTY_LOCAL_STATE,
  type SessionKey,
  type SessionLocalState,
  sessionKeyToString
} from '../../core/session'
import { type AgentTool, isAgentTool } from '../../core/tools'
import {
  isStoredId,
  isStoredTime,
  parseStateFile,
  serializeStateFile,
  type StoredSession
} from './state-file'
import { isMissing } from './source-support'

// AgentPeek's local state store (REQ-010): pins, read cursors, error acknowledgements, and each
// tool's first-start baseline, kept in memory and saved to `state.json` in AgentPeek's own folder
// (Electron's `userData`, or `AGENTPEEK_USER_DATA` in fixture mode). It writes nothing outside that
// folder. The rules for what to store live in src/core (`markRead`, `establishBaseline`); this
// file only keeps and saves the values.
//
// When the saved file was made by a newer AgentPeek or cannot be read, it is left byte-for-byte
// unchanged. The store then starts empty and keeps every change in memory only, until quit.

export const STATE_FILE_NAME = 'state.json'

/** Each save writes here, then renames it over `state.json`: a crash never leaves half a file. */
export const STATE_TEMP_FILE_NAME = 'state.json.tmp'

/** A larger file is not read, and is reported as unreadable. A save never writes a larger one. */
export const MAX_STATE_FILE_BYTES = 4 * 1024 * 1024

/** Changes are saved at most this often, so rapid actions write a few times per second at most. */
export const STATE_WRITE_DELAY_MS = 250

/** A session that no source listed for this long is forgotten, pin and cursors included. */
export const FORGET_AFTER_MS = 90 * 24 * 60 * 60 * 1000

/** How often `lastListedAt` moves forward: precise enough for `FORGET_AFTER_MS`, rarely saved. */
const LISTED_AT_STEP_MS = 24 * 60 * 60 * 1000

/**
 * Whether changes are saved.
 * - `newer-version` and `unreadable`: the saved file was left unchanged and is never written.
 * - `unwritable`: the last save failed, or the state grew past `MAX_STATE_FILE_BYTES`. The next
 *   change tries again.
 */
export type LocalStateStatus =
  | { kind: 'available' }
  | { kind: 'unavailable'; reason: 'newer-version' | 'unreadable' | 'unwritable' }

export interface StateStore {
  status(): LocalStateStatus
  /** A session's state, or `EMPTY_LOCAL_STATE` when nothing is stored for it. */
  localState(key: SessionKey): SessionLocalState
  /**
   * Replaces a session's state: a pin, or a cursor from `markRead`. The empty state removes the
   * entry. Throws `TypeError` for an unknown tool, or an ID or cursor that does not look like one
   * (see `isStoredId`), and stores nothing.
   */
  setLocalState(key: SessionKey, local: SessionLocalState): void
  /** The tool's first-start baseline, or undefined before AgentPeek first read the tool. */
  baseline(tool: AgentTool): number | undefined
  /** Saves the baseline that `establishBaseline` returned. Throws `TypeError` for a bad value. */
  setBaseline(tool: AgentTool, at: number): void
  /**
   * Tells the store which sessions the sources list now, so their entries are kept. An entry not
   * listed for 90 days is dropped the next time the store opens.
   */
  noteListed(keys: readonly SessionKey[]): void
  /** Saves pending changes now and waits for the save. Called before quit. */
  flush(): Promise<void>
}

export interface StateStoreOptions {
  /** AgentPeek's own folder. It is created if missing. */
  folder: string
  now?: () => number
}

/**
 * Reads `state.json` from the folder and returns the store. Never throws for a bad file. Only one
 * store, in one process, may use a folder: two would share the temporary file and could damage
 * `state.json`. The app's single-instance lock makes sure of that.
 */
export async function openStateStore(options: StateStoreOptions): Promise<StateStore> {
  const { folder } = options
  const now = options.now ?? Date.now
  const loaded = await loadStateFile(folder)

  let status: LocalStateStatus =
    loaded.kind === 'state' || loaded.kind === 'missing'
      ? { kind: 'available' }
      : { kind: 'unavailable', reason: loaded.kind }
  // A file that was left unchanged is never written, even after a change.
  const canSave = status.kind === 'available'
  const baselines: Partial<Record<AgentTool, number>> =
    loaded.kind === 'state' ? { ...loaded.data.baselines } : {}
  const sessions = new Map<string, StoredSession>()

  let dirty = false
  let timer: ReturnType<typeof setTimeout> | null = null
  // Saves run one after another, never at the same time.
  let saving: Promise<void> = Promise.resolve()

  function changed(): void {
    if (!canSave) return
    dirty = true
    timer ??= setTimeout(() => {
      timer = null
      void save()
    }, STATE_WRITE_DELAY_MS)
  }

  function save(): Promise<void> {
    saving = saving.then(async () => {
      if (!dirty) return
      dirty = false
      const text = serializeStateFile({ baselines, sessions: [...sessions.values()] })
      try {
        // A file over the cap would be reported as unreadable at the next launch, and then never
        // written again. Refusing it here keeps the saved file usable.
        if (Buffer.byteLength(text, 'utf8') > MAX_STATE_FILE_BYTES) throw new Error('Too large.')
        await writeStateFile(folder, text)
        status = { kind: 'available' }
      } catch {
        // The saved file is unchanged (the rename never happened, or nothing was written). The next
        // change tries again.
        dirty = true
        status = { kind: 'unavailable', reason: 'unwritable' }
      }
    })
    return saving
  }

  if (loaded.kind === 'state') {
    const forgetBefore = now() - FORGET_AFTER_MS
    for (const session of loaded.data.sessions) {
      if (session.lastListedAt < forgetBefore) continue
      sessions.set(sessionKeyToString(session), session)
    }
    if (sessions.size < loaded.data.sessions.length) changed()
  }

  return {
    status: () => status,

    localState(key) {
      const session = sessions.get(sessionKeyToString(key))
      if (session === undefined) return EMPTY_LOCAL_STATE
      const { pinned, seenCursor, acknowledgedErrorCursor } = session
      return { pinned, seenCursor, acknowledgedErrorCursor }
    },

    setLocalState(key, local) {
      checkLocalState(key, local)
      const id = sessionKeyToString(key)
      const current = sessions.get(id)
      if (isEmpty(local)) {
        if (current === undefined) return
        sessions.delete(id)
      } else {
        if (current !== undefined && sameLocalState(current, local)) return
        sessions.set(id, {
          tool: key.tool,
          id: key.id,
          pinned: local.pinned,
          seenCursor: local.seenCursor,
          acknowledgedErrorCursor: local.acknowledgedErrorCursor,
          // The user just acted on it, so it is listed.
          lastListedAt: now()
        })
      }
      changed()
    },

    baseline: (tool) => baselines[tool],

    setBaseline(tool, at) {
      if (!isAgentTool(tool) || !isStoredTime(at)) {
        throw new TypeError('A baseline needs a known tool and a time in epoch milliseconds.')
      }
      if (baselines[tool] === at) return
      baselines[tool] = at
      changed()
    },

    noteListed(keys) {
      const at = now()
      let moved = false
      for (const key of keys) {
        const session = sessions.get(sessionKeyToString(key))
        if (session === undefined || at - session.lastListedAt < LISTED_AT_STEP_MS) continue
        session.lastListedAt = at
        moved = true
      }
      if (moved) changed()
    },

    async flush() {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      await save()
    }
  }
}

type LoadedStateFile =
  | ReturnType<typeof parseStateFile>
  // No file yet: the first launch, or the first since the file was deleted.
  | { kind: 'missing' }

async function loadStateFile(folder: string): Promise<LoadedStateFile> {
  let text: string
  try {
    // O_NONBLOCK keeps a named pipe in the file's place from blocking the open. Anything that is
    // not a regular file (a folder, a pipe, a device) is unreadable, and is never read.
    const handle = await open(
      join(folder, STATE_FILE_NAME),
      constants.O_RDONLY | constants.O_NONBLOCK
    )
    try {
      const stats = await handle.stat()
      if (!stats.isFile() || stats.size > MAX_STATE_FILE_BYTES) return { kind: 'unreadable' }
      text = await handle.readFile('utf8')
    } finally {
      await handle.close()
    }
  } catch (error) {
    return isMissing(error) ? { kind: 'missing' } : { kind: 'unreadable' }
  }
  return parseStateFile(text)
}

/**
 * Writes the whole file to a temporary file in the same folder, flushes it to disk, and renames
 * it over `state.json`. The rename swaps the file in one step. A temporary file left by a crash is
 * ignored when reading, and replaced by the next save.
 */
async function writeStateFile(folder: string, text: string): Promise<void> {
  await mkdir(folder, { recursive: true })
  const temp = join(folder, STATE_TEMP_FILE_NAME)
  // O_NOFOLLOW: a symlink in the temporary file's place is refused, so nothing is written outside
  // the folder.
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW
  const handle = await open(temp, flags, 0o600)
  try {
    await handle.writeFile(text, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temp, join(folder, STATE_FILE_NAME))
}

function checkLocalState(key: SessionKey, local: SessionLocalState): void {
  const valid =
    isAgentTool(key.tool) &&
    isStoredId(key.id) &&
    typeof local.pinned === 'boolean' &&
    (local.seenCursor === null || isStoredId(local.seenCursor)) &&
    (local.acknowledgedErrorCursor === null || isStoredId(local.acknowledgedErrorCursor))
  if (!valid) throw new TypeError('A session key or cursor has an unexpected shape.')
}

function isEmpty(local: SessionLocalState): boolean {
  return !local.pinned && local.seenCursor === null && local.acknowledgedErrorCursor === null
}

function sameLocalState(a: SessionLocalState, b: SessionLocalState): boolean {
  return (
    a.pinned === b.pinned &&
    a.seenCursor === b.seenCursor &&
    a.acknowledgedErrorCursor === b.acknowledgedErrorCursor
  )
}
