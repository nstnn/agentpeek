import { constants, type FileHandle, open, realpath } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'

// The access gate: the only way AgentPeek opens a Codex, Claude Code, or Antigravity file
// (CONSTRAINT-001).
// AgentPeek has no App Sandbox, so this code is the only guard. A path is allowed only when both
// the path as given and its real path (after following symlinks) match the allowlist below, and the
// file is then opened read-only. AgentPeek never writes, renames, locks, or deletes tool files.

interface AllowedFiles {
  /** A folder under the home folder. */
  folder: string
  /**
   * The files allowed inside that folder. `*` stands for any part of one name, and `**` for any
   * number of folders. Neither matches a name that starts with a dot. `{uuid}` at the start of a
   * part stands for a lowercase canonical UUID. A part without `*` or `{uuid}` matches only that
   * exact name, which may start with a dot (`.system_generated`).
   */
  pattern: string
}

const ALLOWLIST: readonly AllowedFiles[] = [
  { folder: '.codex', pattern: 'session_index.jsonl' },
  { folder: '.codex/sessions', pattern: '**/rollout-*.jsonl' },
  { folder: '.claude/sessions', pattern: '*.json' },
  { folder: '.claude/projects', pattern: '*/*.jsonl' },
  {
    folder: 'Library/Application Support/Claude/claude-code-sessions',
    pattern: '*/*/local_*.json'
  },
  // Antigravity Desktop (TASK-003 of the antigravity-desktop plan): one transcript per conversation,
  // and the conversation's title. Never `transcript_full.jsonl`, `conversations/`, or `presence/`.
  {
    folder: '.gemini/antigravity/brain',
    pattern: '{uuid}/.system_generated/logs/transcript.jsonl'
  },
  { folder: '.gemini/antigravity/annotations', pattern: '{uuid}.pbtxt' }
]

/** File names that are never read, even if a pattern matches them: keys and credentials. */
const CREDENTIAL_NAMES = new Set(['auth.json', 'credentials.json', '.credentials.json'])

/**
 * Why the gate refused a path.
 * - `not-normalized`: the path is relative, or has `.` or `..` parts (path traversal).
 * - `credential`: a key or credential file.
 * - `not-allowed`: the path is not in the allowlist.
 * - `symlink-escape`: the path is in the allowlist, but a symlink leads outside it.
 * - `not-a-file`: a folder, a pipe, or anything else that is not a regular file.
 */
export type RefusalReason =
  'not-normalized' | 'credential' | 'not-allowed' | 'symlink-escape' | 'not-a-file'

export class AccessRefusedError extends Error {
  readonly reason: RefusalReason

  constructor(reason: RefusalReason) {
    // The message leaves the path out, so it never ends up in a log.
    super(`AgentPeek refused to read a tool file (${reason}).`)
    this.name = 'AccessRefusedError'
    this.reason = reason
  }
}

export interface AccessGate {
  /**
   * Checks a tool file against the allowlist and returns its real path, or throws
   * `AccessRefusedError`. It never opens the file. A missing file rejects with the usual `ENOENT`.
   */
  resolve(path: string): Promise<string>
  /** Opens an allowed tool file read-only. This is the only place AgentPeek opens a tool file. */
  open(path: string): Promise<FileHandle>
}

/**
 * Creates the gate for one home folder: the user's home, or the fixture folder in fixture mode.
 */
export function createAccessGate(home: string): AccessGate {
  if (!isAbsolute(home)) throw new Error('The home folder must be an absolute path.')
  const homeFolder = resolve(home)
  return {
    resolve: (path) => resolveToolFile(homeFolder, path),
    open: (path) => openToolFile(homeFolder, path)
  }
}

/** A separate, reference-checked reader for SKILL.md only; ordinary tool reads stay unchanged. */
export function createSkillAccessGate(
  home: string,
  workspace: string | null,
  fixture: boolean,
  /** Home folders this tool keeps its own skills in, such as Antigravity's `.gemini/config/skills`. */
  toolFolders: readonly string[] = []
): AccessGate {
  if (!isAbsolute(home)) throw new Error('The home folder must be an absolute path.')
  const entries: AllowedFiles[] = [
    { folder: '.agents/skills', pattern: '**/SKILL.md' },
    { folder: '.codex/skills', pattern: '**/SKILL.md' },
    { folder: '.codex/skills/.system', pattern: '**/SKILL.md' },
    { folder: '.claude/skills', pattern: '**/SKILL.md' },
    { folder: '.codex/plugins/cache', pattern: '**/skills/**/SKILL.md' },
    ...toolFolders.map((folder) => ({ folder, pattern: '**/SKILL.md' }))
  ]
  if (
    !fixture &&
    workspace &&
    isAbsolute(workspace) &&
    resolve(workspace) === workspace &&
    workspace !== sep
  ) {
    for (const folder of ['.agents/skills', '.codex/skills', '.claude/skills']) {
      entries.push({ folder: join(workspace, folder), pattern: '**/SKILL.md' })
    }
  }
  const resolveSkill = async (path: string) => {
    const resolved = await resolveToolFile(resolve(home), path, entries)
    if (fixture) {
      const inside = relative(await realpath(home), resolved)
      if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
        throw new AccessRefusedError('symlink-escape')
      }
    }
    return resolved
  }
  return { resolve: resolveSkill, open: async (path) => openRegularFile(await resolveSkill(path)) }
}

async function resolveToolFile(
  home: string,
  path: string,
  entries: readonly AllowedFiles[] = ALLOWLIST
): Promise<string> {
  // These checks only look at the path, so a refused path never reaches the disk.
  if (!isAbsolute(path) || resolve(path) !== path) throw new AccessRefusedError('not-normalized')
  if (isCredentialName(basename(path))) throw new AccessRefusedError('credential')
  const folderOf = (entry: AllowedFiles) =>
    isAbsolute(entry.folder) ? entry.folder : join(home, entry.folder)
  const entry = entries.find((allowed) => matchesAllowed(folderOf(allowed), path, allowed.pattern))
  if (entry === undefined) throw new AccessRefusedError('not-allowed')

  // Follow symlinks, then check the real path against the folder's own real path. This catches a
  // symlink inside the tool's folder that leads anywhere else. It reads only folder entries, never
  // the file itself.
  const [realFolder, realPath] = await Promise.all([realpath(folderOf(entry)), realpath(path)])
  if (!matchesAllowed(realFolder, realPath, entry.pattern)) {
    throw new AccessRefusedError('symlink-escape')
  }
  return realPath
}

async function openToolFile(home: string, path: string): Promise<FileHandle> {
  const realPath = await resolveToolFile(home, path)
  return openRegularFile(realPath)
}

async function openRegularFile(realPath: string): Promise<FileHandle> {
  // Read-only. O_NOFOLLOW refuses a symlink swapped in after the check, and O_NONBLOCK keeps a
  // named pipe from blocking the open.
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  const handle = await open(realPath, flags)
  try {
    const stats = await handle.stat()
    if (!stats.isFile()) throw new AccessRefusedError('not-a-file')
    return handle
  } catch (error) {
    await handle.close()
    throw error
  }
}

function isCredentialName(name: string): boolean {
  // macOS file names ignore case by default, so `AUTH.JSON` is the same file as `auth.json`.
  const lowerCase = name.toLowerCase()
  return lowerCase.endsWith('.key') || CREDENTIAL_NAMES.has(lowerCase)
}

/** Whether `path` lies inside `folder` and matches `pattern` there. */
function matchesAllowed(folder: string, path: string, pattern: string): boolean {
  const inside = relative(folder, path)
  if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    return false
  }
  const names = inside.split(sep)
  return !isCredentialName(names.at(-1) ?? '') && matchesNames(names, pattern.split('/'))
}

function matchesNames(names: readonly string[], parts: readonly string[]): boolean {
  const [part, ...restParts] = parts
  if (part === undefined) return names.length === 0
  if (part === '**') {
    // Try zero folders, then one, and so on.
    for (let count = 0; count <= names.length; count++) {
      const folders = names.slice(0, count)
      if (folders.every(isPlainName) && matchesNames(names.slice(count), restParts)) return true
    }
    return false
  }
  const [name, ...restNames] = names
  return name !== undefined && matchesName(name, part) && matchesNames(restNames, restParts)
}

/** Matches one name against a pattern part with at most one `*`, or a leading `{uuid}`. */
function matchesName(name: string, part: string): boolean {
  if (name === '') return false
  if (part.startsWith(UUID_PART)) {
    const suffix = part.slice(UUID_PART.length)
    return name.endsWith(suffix) && UUID.test(name.slice(0, name.length - suffix.length))
  }
  const star = part.indexOf('*')
  // A literal part names one exact file or folder, so it may name a hidden one.
  if (star === -1) return name === part
  if (!isPlainName(name)) return false
  const prefix = part.slice(0, star)
  const suffix = part.slice(star + 1)
  return (
    name.length >= prefix.length + suffix.length && name.startsWith(prefix) && name.endsWith(suffix)
  )
}

const UUID_PART = '{uuid}'

/** A lowercase canonical UUID, the form Antigravity uses for conversation IDs. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** A name a wildcard may match: not empty, and not hidden (starting with a dot). */
function isPlainName(name: string): boolean {
  return name !== '' && !name.startsWith('.')
}
