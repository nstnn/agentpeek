import type { Dirent, Stats } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { isMissing } from './source-support'

// Where Claude Code keeps its files, and metadata-only listings of them. Listing a folder and
// reading a file's modification time never open the file (CONSTRAINT-005). Opening goes through the
// access gate.

export interface ClaudePaths {
  /** `~/.claude/sessions`: one registry file per running Claude Code process. */
  registry: string
  /** `~/.claude/projects`: transcripts, in one folder per working folder. */
  projects: string
  /** Claude.app's catalog: `<account>/<organization>/local_<id>.json`, one file per session. */
  catalog: string
}

export function claudePaths(home: string): ClaudePaths {
  return {
    registry: join(home, '.claude', 'sessions'),
    projects: join(home, '.claude', 'projects'),
    catalog: join(home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions')
  }
}

/** A file found by a listing. */
export interface ListedFile {
  path: string
  modifiedAt: number
  /**
   * The file's identity, size, and modification time together. When it is unchanged, so is the
   * file, and it need not be read again.
   */
  signature: string
}

/** What a path, such as one a watcher reported, names. */
export type ClaudePathKind =
  | { kind: 'registry' }
  | { kind: 'catalog' }
  | { kind: 'transcript'; sessionId: string }
  | { kind: 'other' }

/**
 * A registry file is `<pid>.json`. Next to it, Claude Code keeps a `<pid>.<hash>.key` file, which
 * AgentPeek never opens (TASK-002).
 */
export function isRegistryName(name: string): boolean {
  return /^\d+\.json$/.test(name)
}

function isCatalogName(name: string): boolean {
  return name.startsWith('local_') && name.endsWith('.json')
}

/**
 * Whether a session ID can name a transcript. Claude Code's IDs are UUIDs; anything else, such as
 * an ID with a `/`, never becomes part of a path.
 */
function isSessionId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)
}

/** The session ID in a transcript's file name, `<session id>.jsonl`, or null for another name. */
function transcriptSessionId(name: string): string | null {
  if (!name.endsWith('.jsonl')) return null
  const sessionId = name.slice(0, -'.jsonl'.length)
  return isSessionId(sessionId) ? sessionId : null
}

export function classifyPath(paths: ClaudePaths, path: string): ClaudePathKind {
  const registry = namesInside(paths.registry, path)
  if (registry?.length === 1 && isRegistryName(registry[0] ?? '')) return { kind: 'registry' }
  const catalog = namesInside(paths.catalog, path)
  if (catalog?.length === 3 && isCatalogName(catalog[2] ?? '') && catalog.every(isPlainName)) {
    return { kind: 'catalog' }
  }
  // Only the top level of each project folder: never `<id>/subagents/` or `<id>/tool-results/`.
  const projects = namesInside(paths.projects, path)
  if (projects?.length === 2 && isPlainName(projects[0] ?? '')) {
    const sessionId = transcriptSessionId(projects[1] ?? '')
    if (sessionId !== null) return { kind: 'transcript', sessionId }
  }
  return { kind: 'other' }
}

/**
 * The transcript folder Claude Code uses for a working folder: every character other than a-z,
 * A-Z, and 0-9 becomes `-` (TASK-003: true for 97 of 97 sessions). Claude Code shortens very long
 * names differently, so `findTranscript` also searches the folders.
 */
export function projectFolderName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

/** The registry files, with their signatures. Errors on the folder itself reach the caller. */
export async function listRegistryFiles(paths: ClaudePaths): Promise<ListedFile[]> {
  const entries = await readdir(paths.registry, { withFileTypes: true })
  const files: ListedFile[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !isRegistryName(entry.name)) continue
    const file = await statFile(join(paths.registry, entry.name))
    if (file !== null) files.push(file)
  }
  return files
}

/**
 * The catalog files (`<account>/<organization>/local_<id>.json`), with their signatures. Errors on
 * the catalog folder itself reach the caller; a subfolder or file that vanishes during the listing
 * is skipped.
 */
export async function listCatalogFiles(paths: ClaudePaths): Promise<ListedFile[]> {
  const files: ListedFile[] = []
  for (const account of await readdir(paths.catalog, { withFileTypes: true })) {
    if (!account.isDirectory() || !isPlainName(account.name)) continue
    const accountPath = join(paths.catalog, account.name)
    for (const organization of await listFolder(accountPath)) {
      if (!organization.isDirectory() || !isPlainName(organization.name)) continue
      const organizationPath = join(accountPath, organization.name)
      for (const entry of await listFolder(organizationPath)) {
        if (!entry.isFile() || !isCatalogName(entry.name)) continue
        const file = await statFile(join(organizationPath, entry.name))
        if (file !== null) files.push(file)
      }
    }
  }
  return files
}

/** Whether a folder can be listed: `missing` when it is not there, `no-access` on any other error. */
export async function checkFolder(path: string): Promise<'present' | 'missing' | 'no-access'> {
  try {
    await readdir(path)
    return 'present'
  } catch (error) {
    return isMissing(error) ? 'missing' : 'no-access'
  }
}

/**
 * Finds a session's transcript: first in the folder named after each working folder given, then
 * in every project folder. Returns null when there is none.
 */
export async function findTranscript(
  paths: ClaudePaths,
  sessionId: string,
  workingFolders: readonly string[]
): Promise<ListedFile | null> {
  if (!isSessionId(sessionId)) return null
  const name = `${sessionId}.jsonl`
  for (const cwd of workingFolders) {
    const file = await statFile(join(paths.projects, projectFolderName(cwd), name))
    if (file !== null) return file
  }
  for (const folder of await listFolder(paths.projects)) {
    if (!folder.isDirectory() || !isPlainName(folder.name)) continue
    const file = await statFile(join(paths.projects, folder.name, name))
    if (file !== null) return file
  }
  return null
}

/** A file's modification time and signature, or null when it is not there or not a regular file. */
export async function statFile(path: string): Promise<ListedFile | null> {
  const stats = await lstat(path).catch(() => null)
  if (stats?.isFile() !== true) return null
  return { path, modifiedAt: stats.mtimeMs, signature: signature(stats) }
}

function signature(stats: Stats): string {
  return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}`
}

/** A subfolder's entries, or none when it cannot be listed. */
async function listFolder(path: string): Promise<Dirent[]> {
  return readdir(path, { withFileTypes: true }).catch(() => [])
}

/** The names of the parts of `path` below `folder`, or null when it is not inside `folder`. */
function namesInside(folder: string, path: string): string[] | null {
  if (!isAbsolute(path)) return null
  const inside = relative(folder, path)
  if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    return null
  }
  return inside.split(sep)
}

/** A name AgentPeek may follow: not empty, and not hidden (starting with a dot). */
function isPlainName(name: string): boolean {
  return name !== '' && !name.startsWith('.')
}
