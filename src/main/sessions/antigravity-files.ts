import { readdir } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { type ListedFile, statFile } from './claude-files'

// Where Antigravity Desktop keeps its files, and a metadata-only listing of its transcripts. The
// listing reads folder entries and modification times; it never opens a file (CONSTRAINT-001).
// Opening goes through the access gate, which allows exactly the two file shapes named here.

export interface AntigravityPaths {
  /** `~/.gemini/antigravity/brain`: one `<conversation id>` folder per conversation. */
  brain: string
  /** `~/.gemini/antigravity/annotations`: `<conversation id>.pbtxt`, holding the title. */
  annotations: string
}

export function antigravityPaths(home: string): AntigravityPaths {
  const root = join(home, '.gemini', 'antigravity')
  return { brain: join(root, 'brain'), annotations: join(root, 'annotations') }
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

export interface TranscriptFile extends ListedFile {
  conversationId: string
}

/**
 * Lists every conversation transcript with its signature. Errors on `brain/` itself, such as a
 * missing folder, reach the caller. A folder without a transcript (a legacy conversation) and a
 * transcript that vanishes during the listing are skipped. Symlinked conversation folders are
 * never followed: the folder listing reports them as neither folders nor files.
 */
export async function listTranscripts(paths: AntigravityPaths): Promise<TranscriptFile[]> {
  const files: TranscriptFile[] = []
  for (const entry of await readdir(paths.brain, { withFileTypes: true })) {
    if (!entry.isDirectory() || !isConversationId(entry.name)) continue
    const file = await statFile(transcriptPath(paths, entry.name))
    if (file !== null) files.push({ ...file, conversationId: entry.name })
  }
  return files
}

/** The names of the parts of `path` below `folder`, or null when it is not inside `folder`. */
function namesInside(folder: string, path: string): string[] | null {
  const inside = relative(folder, path)
  if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    return null
  }
  return inside.split(sep)
}
