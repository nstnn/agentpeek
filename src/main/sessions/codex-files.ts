import type { Dirent } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, sep } from 'node:path'

// Where Codex keeps its files, and the metadata-only sweep of its rollouts. The sweep lists folders
// and reads modification times; it never opens a file (CONSTRAINT-005). Opening goes through the
// access gate.

export interface CodexPaths {
  /** `~/.codex/session_index.jsonl`: thread names. */
  index: string
  /** `~/.codex/sessions`: rollouts in `YYYY/MM/DD` folders. */
  sessions: string
}

export function codexPaths(home: string): CodexPaths {
  return {
    index: join(home, '.codex', 'session_index.jsonl'),
    sessions: join(home, '.codex', 'sessions')
  }
}

export interface RolloutFile {
  path: string
  modifiedAt: number
}

/** Rollouts sit three folders deep (`YYYY/MM/DD`). One more level is allowed in case that changes. */
const MAX_FOLDER_DEPTH = 4

/**
 * A rollout's file name: `rollout-<time>-<thread id>.jsonl`. Codex compresses rollouts it has not
 * written for about a week into `.jsonl.zst` files, which AgentPeek does not read.
 */
export function isRolloutName(name: string): boolean {
  return name.startsWith('rollout-') && name.endsWith('.jsonl')
}

/** Whether a path, such as one a watcher reported, names a rollout. */
export function isRolloutPath(paths: CodexPaths, path: string): boolean {
  const inside = relative(paths.sessions, path)
  return (
    inside !== '' &&
    !inside.startsWith(`..${sep}`) &&
    !isAbsolute(inside) &&
    isRolloutName(basename(path))
  )
}

/**
 * Lists every rollout under the sessions folder with its modification time (TASK-004: the
 * reconcile sweep). Errors on the sessions folder itself, such as a missing folder, reach the
 * caller. A subfolder or file that vanishes during the sweep is skipped. Symlinks are never
 * followed: the folder listing reports them as neither folders nor files.
 */
export async function sweepRollouts(sessionsFolder: string): Promise<RolloutFile[]> {
  const files: RolloutFile[] = []
  const entries = await readdir(sessionsFolder, { withFileTypes: true })
  await collect(sessionsFolder, entries, 1, files)
  return files
}

async function collect(
  folder: string,
  entries: readonly Dirent[],
  depth: number,
  files: RolloutFile[]
): Promise<void> {
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const path = join(folder, entry.name)
    if (entry.isDirectory() && depth <= MAX_FOLDER_DEPTH) {
      const children = await readdir(path, { withFileTypes: true }).catch(() => null)
      if (children !== null) await collect(path, children, depth + 1, files)
    } else if (entry.isFile() && isRolloutName(entry.name)) {
      const stats = await lstat(path).catch(() => null)
      if (stats?.isFile() === true) files.push({ path, modifiedAt: stats.mtimeMs })
    }
  }
}
