import { watch } from 'node:fs'
import { lstat, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentTool } from '../../core/tools'
import { AGENT_TOOLS } from '../../core/tools'
import type { AccessGate } from './access'
import { isMissing } from './source-support'

// The file watcher (TASK-010, as decided in TASK-002). While the window is open, it tells the
// sessions service which of the tools' files changed, so only those are read again (REQ-008). It
// uses plain `fs.watch` in two ways:
// - A folder watch on each of the tools' folders. It reports a new file at once, and a written file
//   once its writer closes it.
// - A file watch on each file a source names in `watchedFiles()`. Codex keeps a rollout open while
//   it appends to it, so a folder watch never sees those appends; a file watch sees each one.
// An event is only a hint: its name is unreliable, and some events change nothing. Events are
// gathered for a moment, then each file's identity and size (and, for files rewritten in place, its
// modification time) are compared with what was last reported, and only files that changed are
// reported. A path is looked at only when it passes the filter of the folder it is in, so files
// such as `.key` files or Codex's own state files are never touched. The watcher never reads a file
// and never logs a path.
//
// `fs.watch` opens the path it watches itself (a read-only descriptor), without the access gate's
// protections: it follows a symlink, and it waits for a writer when the path is a named pipe, which
// would block the main process. So a path is checked first, from its metadata only: a file must be a
// regular file (not a symlink) that the access gate allows, and a watched folder must be a folder.
// Nothing can stop a swap in the moment between the check and the watch, because `fs.watch` takes
// no open flags; that needs something running as the user to change the tools' folders on purpose.

/** One folder to watch, and which changed paths in it matter to a tool's source. */
export interface FolderWatch {
  tool: AgentTool
  folder: string
  /** Whether to watch the subfolders too. */
  recursive: boolean
  /** Whether a path in the folder names a file that the tool's source reads. */
  accepts(path: string): boolean
}

/** Receives the files of one tool that changed. */
export type ChangeListener = (tool: AgentTool, paths: string[]) => void

/** What the sessions service uses. Tests pass a fake. */
export interface SessionWatcher {
  /**
   * Starts the folder watches that are not running, and resolves once they are running. A folder
   * that is missing (the tool is not installed), is not a folder, or cannot be watched is tried
   * again at the next call: the service calls this at launch and at each reconcile, before reading.
   * Files whose watch failed are tried again too.
   */
  watchFolders(enabledTools?: readonly AgentTool[]): Promise<void>
  /**
   * Sets the files of one tool that get their own watch: starts the new ones once they pass their
   * checks, and stops the ones no longer named. Each new watch reports its file once, so a write
   * made before the watch existed is not missed. A file that fails its checks, or whose watch fails,
   * is tried again only after an event shows it is there, or after the next `watchFolders`.
   */
  watchFiles(tool: AgentTool, paths: readonly string[]): void
  /** Stops every watch and drops the events not reported yet. Nothing is reported afterwards. */
  close(): void
}

/** A running `fs.watch`, reduced to what the watcher uses. */
export interface WatchHandle {
  close(): void
}

/**
 * Starts watching a folder or a file. Throws when it cannot, for example `ENOENT` for a missing
 * path. `name` is the changed entry's path relative to a watched folder, or null when unknown.
 */
export type WatchFunction = (
  path: string,
  recursive: boolean,
  onEvent: (event: string, name: string | null) => void,
  onError: () => void
) => WatchHandle

export interface FileWatcherOptions {
  folders: readonly FolderWatch[]
  onChange: ChangeListener
  /** The access gate for the same home folder. A file gets its own watch only if the gate allows it. */
  gate: Pick<AccessGate, 'resolve'>
  /** `fs.watch` by default. Tests pass their own. */
  watch?: WatchFunction
  /** How long events are gathered before the changed files are reported. */
  delayMs?: number
}

/**
 * Events are gathered this long before they are reported. A catalog file's replacement arrives as
 * two events, and a busy Codex turn can write many times a second (TASK-002).
 */
export const WATCH_DELAY_MS = 100

/** What `readSignature` returns for a file that is not there. */
const MISSING = 'missing'

export function createFileWatcher(options: FileWatcherOptions): SessionWatcher {
  const startWatch = options.watch ?? watchWithNode
  const delayMs = options.delayMs ?? WATCH_DELAY_MS

  const folderWatches = new Map<FolderWatch, WatchHandle>()
  /** The files each tool names now, after the filters. */
  const wantedFiles = new Map<string, AgentTool>()
  const fileWatches = new Map<string, { tool: AgentTool; handle: WatchHandle }>()
  /** Files whose checks are running. */
  const startingFiles = new Set<string>()
  /**
   * Files that failed their checks or whose watch could not start. Each is tried again once an
   * event shows it is there (it was replaced, and briefly missing, when its watch restarted), or
   * after the next `watchFolders`.
   */
  const failedFiles = new Map<string, AgentTool>()
  /** What was last reported for each file, by path. */
  const signatures = new Map<string, string>()
  /** Files with events not reported yet, and their tools. */
  let pending = new Map<string, AgentTool>()
  let timer: ReturnType<typeof setTimeout> | null = null
  // Reports run one after another, so they never compare against each other's signatures.
  let reporting: Promise<void> = Promise.resolve()
  let closed = false
  let enabled = new Set<AgentTool>(AGENT_TOOLS)

  /** Notes an event on a file. The first event starts the delay; later ones join it. */
  function hint(tool: AgentTool, path: string): void {
    if (closed || !enabled.has(tool)) return
    pending.set(path, tool)
    timer ??= setTimeout(() => {
      timer = null
      // A listener that throws must not stop later reports.
      reporting = reporting.then(report).catch(() => undefined)
    }, delayMs)
  }

  async function report(): Promise<void> {
    const batch = pending
    pending = new Map()
    const found = await Promise.all(
      [...batch]
        .filter(([, tool]) => enabled.has(tool))
        .map(async ([path, tool]) => ({ path, tool, signature: await readSignature(path) }))
    )
    if (closed) return
    const changed = new Map<AgentTool, string[]>()
    for (const { path, tool, signature } of found) {
      if (!enabled.has(tool)) continue
      const present = signature !== null && signature !== MISSING
      // The file is there again, so the next `watchFiles` tries its watch again. A file whose watch
      // keeps failing is tried only when an event shows it, so this never loops.
      if (present) failedFiles.delete(path)
      // Same identity and size as last time: nothing to read.
      if (present && signatures.get(path) === signature) continue
      // A removed file is forgotten, so the map only holds files that exist. A file that could not
      // be looked at is always reported, and its source finds out why.
      if (present) signatures.set(path, signature)
      else signatures.delete(path)
      const paths = changed.get(tool) ?? []
      paths.push(path)
      changed.set(tool, paths)
    }
    for (const [tool, paths] of changed) options.onChange(tool, paths)
  }

  /** Starts a folder's watch if it is not running, once a check shows that the path is a folder. */
  async function startFolder(folder: FolderWatch): Promise<void> {
    if (!enabled.has(folder.tool) || folderWatches.has(folder)) return
    const folderThere = await isFolder(folder.folder)
    // Checked again: another call may have started it during the check.
    if (folderThere && !closed && enabled.has(folder.tool) && !folderWatches.has(folder))
      watchFolder(folder)
  }

  function watchFolder(folder: FolderWatch): void {
    let handle: WatchHandle
    try {
      handle = startWatch(
        folder.folder,
        folder.recursive,
        (_event, name) => {
          if (name === null) return
          const path = join(folder.folder, name)
          if (folder.accepts(path)) hint(folder.tool, path)
        },
        () => {
          // The watch broke. It starts again at the next reconcile, which also reads everything.
          if (folderWatches.get(folder) !== handle) return
          handle.close()
          folderWatches.delete(folder)
        }
      )
    } catch {
      // Missing (the tool is not installed) or not allowed: tried again at the next reconcile.
      return
    }
    folderWatches.set(folder, handle)
  }

  /** Starts a file's watch. Returns false when it cannot start. */
  function watchFile(tool: AgentTool, path: string): boolean {
    let handle: WatchHandle
    try {
      handle = startWatch(
        path,
        false,
        (event) => {
          if (fileWatches.get(path)?.handle !== handle) return
          // The watched file was renamed, replaced, or removed: watch what the path names now, once
          // it passes the checks again.
          if (event === 'rename') {
            handle.close()
            fileWatches.delete(path)
            void attachFile(tool, path)
          }
          hint(tool, path)
        },
        () => {
          if (fileWatches.get(path)?.handle !== handle) return
          handle.close()
          fileWatches.delete(path)
          failedFiles.set(path, tool)
        }
      )
    } catch {
      return false
    }
    fileWatches.set(path, { tool, handle })
    return true
  }

  /**
   * Starts a file's watch once its checks pass, then reports the file once. A file that fails them,
   * or whose watch cannot start, is not reported (its source would only name it again) and waits in
   * `failedFiles`.
   */
  async function attachFile(tool: AgentTool, path: string): Promise<void> {
    startingFiles.add(path)
    let allowed: boolean
    try {
      allowed = await canWatchFile(path)
    } finally {
      startingFiles.delete(path)
    }
    // The watcher closed, or the source stopped naming the file, while it was checked.
    if (closed || !enabled.has(tool) || wantedFiles.get(path) !== tool || fileWatches.has(path))
      return
    if (allowed && watchFile(tool, path)) hint(tool, path)
    else failedFiles.set(path, tool)
  }

  /**
   * Whether a file may get its own watch: a regular file, not a symlink or a named pipe, that the
   * access gate allows. Only metadata and folder entries are read.
   */
  async function canWatchFile(path: string): Promise<boolean> {
    try {
      const stats = await lstat(path)
      if (!stats.isFile()) return false
      await options.gate.resolve(path)
      return true
    } catch {
      return false
    }
  }

  /** Whether one of the tool's folder filters accepts the path: no other file gets a watch. */
  function acceptsFile(tool: AgentTool, path: string): boolean {
    return options.folders.some((folder) => folder.tool === tool && folder.accepts(path))
  }

  return {
    async watchFolders(enabledTools = AGENT_TOOLS) {
      if (closed) return
      enabled = new Set(enabledTools)
      for (const [folder, handle] of folderWatches) {
        if (enabled.has(folder.tool)) continue
        handle.close()
        folderWatches.delete(folder)
      }
      for (const tool of AGENT_TOOLS) {
        if (enabled.has(tool)) continue
        this.watchFiles(tool, [])
        for (const [path, pendingTool] of pending) {
          if (pendingTool === tool) {
            pending.delete(path)
            signatures.delete(path)
          }
        }
      }
      failedFiles.clear()
      await Promise.all(options.folders.map(startFolder))
    },

    watchFiles(tool, paths) {
      if (closed) return
      const wanted = new Set(
        enabled.has(tool) ? paths.filter((path) => acceptsFile(tool, path)) : []
      )
      for (const [path, wantedTool] of wantedFiles) {
        if (wantedTool === tool && !wanted.has(path)) wantedFiles.delete(path)
      }
      for (const path of wanted) wantedFiles.set(path, tool)
      for (const [path, watched] of fileWatches) {
        if (watched.tool !== tool || wanted.has(path)) continue
        watched.handle.close()
        fileWatches.delete(path)
      }
      for (const [path, failedTool] of failedFiles) {
        if (failedTool === tool && !wanted.has(path)) failedFiles.delete(path)
      }
      for (const path of wanted) {
        if (fileWatches.has(path) || failedFiles.has(path) || startingFiles.has(path)) continue
        void attachFile(tool, path)
      }
    },

    close() {
      closed = true
      if (timer !== null) clearTimeout(timer)
      timer = null
      pending.clear()
      for (const handle of folderWatches.values()) handle.close()
      for (const { handle } of fileWatches.values()) handle.close()
      folderWatches.clear()
      fileWatches.clear()
      wantedFiles.clear()
      failedFiles.clear()
      signatures.clear()
    }
  }
}

/**
 * A file's identity and size, which change when an append-only log (`.jsonl`) grows or is
 * replaced. Small JSON files are rewritten in place, sometimes at the same size (a registry's
 * status changing from `busy` to `idle`), so their modification time counts too. `MISSING` when
 * the file is not there, and null when it cannot be looked at. Only metadata is read.
 */
async function readSignature(path: string): Promise<string | null> {
  try {
    const stats = await lstat(path, { bigint: true })
    const identity = `${stats.dev}:${stats.ino}:${stats.size}`
    return path.endsWith('.jsonl') ? identity : `${identity}:${stats.mtimeNs}`
  } catch (error) {
    return isMissing(error) ? MISSING : null
  }
}

/**
 * Whether a path is a folder, following a symlink (a tool's folder may be one). Anything else, such
 * as a named pipe in a folder's place, gets no watch.
 */
async function isFolder(path: string): Promise<boolean> {
  const stats = await stat(path).catch(() => null)
  return stats?.isDirectory() === true
}

/** `fs.watch`. It does not keep the process alive by itself; `close` stops it. */
function watchWithNode(
  path: string,
  recursive: boolean,
  onEvent: (event: string, name: string | null) => void,
  onError: () => void
): WatchHandle {
  const watcher = watch(path, { recursive, persistent: false, encoding: 'utf8' }, onEvent)
  watcher.on('error', onError)
  return watcher
}
