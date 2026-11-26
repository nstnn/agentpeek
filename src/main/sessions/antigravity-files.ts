import type { BigIntStats } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

// Where Antigravity Desktop keeps its files, and a metadata-only listing of its transcripts. The
// listing reads folder entries and modification times; it never opens a file (CONSTRAINT-001).
// Opening goes through the access gate, which allows exactly the file shapes named here.

export interface AntigravityPaths {
  /** `~/.gemini/antigravity/brain`: one `<conversation id>` folder per conversation. */
  brain: string
  /** `~/.gemini/antigravity/annotations`: `<conversation id>.pbtxt` with title and archive flag. */
  annotations: string
  /** `~/.gemini/antigravity/conversation_summaries.db`: each conversation's workspace. */
  summaries: string
}

export function antigravityPaths(home: string): AntigravityPaths {
  const root = join(home, '.gemini', 'antigravity')
  return {
    brain: join(root, 'brain'),
    annotations: join(root, 'annotations'),
    summaries: join(root, 'conversation_summaries.db')
  }
}

/** The transcript's place inside a conversation folder (Antigravity Desktop 2.34.0). */
const TRANSCRIPT_NAMES = ['.system_generated', 'logs', 'transcript.jsonl'] as const

const ANNOTATION_SUFFIX = '.pbtxt'

/**
 * Whether a folder name is a conversation ID: a lowercase canonical UUID. `brain/` also holds
 * other folders, such as `tempmediaStorage`, which are never conversations.
 */
export function isConversationId(name: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(name)
}

export function transcriptPath(paths: AntigravityPaths, conversationId: string): string {
  return join(paths.brain, conversationId, ...TRANSCRIPT_NAMES)
}

export function annotationPath(paths: AntigravityPaths, conversationId: string): string {
  return join(paths.annotations, `${conversationId}${ANNOTATION_SUFFIX}`)
}

/** What a path, such as one a watcher reported, names. */
export type AntigravityPathKind =
  | { kind: 'transcript'; conversationId: string }
  | { kind: 'annotation'; conversationId: string }
  | { kind: 'other' }

export function classifyAntigravityPath(
  paths: AntigravityPaths,
  path: string
): AntigravityPathKind {
  // A relative path, or one with `.` or `..` parts: the access gate refuses it, so it never reads.
  if (!isAbsolute(path) || resolve(path) !== path) return { kind: 'other' }
  const brain = namesInside(paths.brain, path)
  if (
    brain?.length === TRANSCRIPT_NAMES.length + 1 &&
    isConversationId(brain[0] ?? '') &&
    TRANSCRIPT_NAMES.every((name, index) => brain[index + 1] === name)
  ) {
    return { kind: 'transcript', conversationId: brain[0] ?? '' }
  }
  const annotations = namesInside(paths.annotations, path)
  const name = annotations?.length === 1 ? (annotations[0] ?? '') : ''
  if (name.endsWith(ANNOTATION_SUFFIX)) {
    const conversationId = name.slice(0, -ANNOTATION_SUFFIX.length)
    if (isConversationId(conversationId)) return { kind: 'annotation', conversationId }
  }
  return { kind: 'other' }
}

export interface TranscriptFile {
  conversationId: string
  path: string
  fileId: string
  modifiedAt: number
  signature: string
}

/** Change identity for one file version, also checked on the opened descriptor. */
export function transcriptSignature(stats: BigIntStats): string {
  return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`
}

/**
 * Lists every conversation transcript with its signature. Errors on `brain/` itself, such as a
 * missing folder, reach the caller. A folder without a transcript (a legacy conversation) and a
 * transcript that vanishes during the listing are skipped. Symlinks are never followed below
 * `brain/`: the conversation folder, `.system_generated` and `logs` must each be a real folder, and
 * the transcript a regular file, so discovery never reports a file outside `brain/`.
 */
export async function listTranscripts(paths: AntigravityPaths): Promise<TranscriptFile[]> {
  const files: TranscriptFile[] = []
  for (const entry of await readdir(paths.brain, { withFileTypes: true })) {
    if (!entry.isDirectory() || !isConversationId(entry.name)) continue
    const file = await statTranscript(paths, entry.name)
    if (file !== null) files.push(file)
  }
  return files
}

/**
 * One conversation's transcript and its signature, with the same checks as `listTranscripts`, or
 * null when it is not there, the ID is not a conversation ID, or a folder on the way is a symlink.
 */
export async function statTranscript(
  paths: AntigravityPaths,
  conversationId: string
): Promise<TranscriptFile | null> {
  if (!isConversationId(conversationId)) return null
  const conversation = join(paths.brain, conversationId)
  const stats = await lstat(conversation).catch(() => null)
  if (stats?.isDirectory() !== true || !(await hasRealFolders(conversation))) return null
  const path = transcriptPath(paths, conversationId)
  const file = await lstat(path, { bigint: true }).catch(() => null)
  if (file?.isFile() !== true) return null
  return {
    conversationId,
    path,
    fileId: `${file.dev}:${file.ino}`,
    modifiedAt: Number(file.mtimeNs) / 1_000_000,
    signature: transcriptSignature(file)
  }
}

/** Whether each folder on the way to the transcript is a real folder and not a symlink. */
async function hasRealFolders(conversation: string): Promise<boolean> {
  let folder = conversation
  for (const name of TRANSCRIPT_NAMES.slice(0, -1)) {
    folder = join(folder, name)
    const stats = await lstat(folder).catch(() => null)
    if (stats?.isDirectory() !== true) return false
  }
  return true
}

/** The names of the parts of `path` below `folder`, or null when it is not inside `folder`. */
function namesInside(folder: string, path: string): string[] | null {
  const inside = relative(folder, path)
  if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    return null
  }
  return inside.split(sep)
}
