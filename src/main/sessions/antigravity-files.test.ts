import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAccessGate } from './access'
import {
  annotationPath,
  antigravityPaths,
  classifyAntigravityPath,
  isConversationId,
  listTranscripts,
  statTranscript,
  transcriptPath
} from './antigravity-files'

// Synthetic conversation IDs and files only, in a temporary folder that stands in for home.
const FIRST = '0f8e2c4a-1b3d-4e5f-8a9b-0c1d2e3f4a5b'
const SECOND = '7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d'

let root: string
let home: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agentpeek-antigravity-'))
  home = join(root, 'home')
  await mkdir(home)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function createFile(path: string, content = '{"type":"synthetic"}\n'): Promise<string> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
  return path
}

describe('isConversationId', () => {
  it('accepts only lowercase canonical UUIDs', () => {
    expect(isConversationId(FIRST)).toBe(true)
    for (const name of [
      FIRST.toUpperCase(),
      FIRST.slice(1),
      `${FIRST}.pbtxt`,
      'tempmediaStorage',
      '',
      '.hidden',
      FIRST.replaceAll('-', '')
    ]) {
      expect(isConversationId(name)).toBe(false)
    }
  })
})

describe('classifyAntigravityPath', () => {
  it('names the transcript and the title of a conversation', () => {
    const paths = antigravityPaths(home)
    expect(classifyAntigravityPath(paths, transcriptPath(paths, FIRST))).toEqual({
      kind: 'transcript',
      conversationId: FIRST
    })
    expect(classifyAntigravityPath(paths, annotationPath(paths, FIRST))).toEqual({
      kind: 'annotation',
      conversationId: FIRST
    })
  })

  it('treats every other path as other, like the access gate', () => {
    const paths = antigravityPaths(home)
    const logs = join(paths.brain, FIRST, '.system_generated', 'logs')
    for (const path of [
      paths.brain,
      join(paths.brain, FIRST),
      logs,
      join(logs, 'transcript_full.jsonl'),
      join(logs, 'chunks', 'transcript', '0.jsonl'),
      join(paths.brain, FIRST, 'task.md'),
      join(paths.brain, 'tempmediaStorage', '.system_generated', 'logs', 'transcript.jsonl'),
      join(paths.annotations, 'title.pbtxt'),
      join(paths.annotations, `${FIRST}.pbtxt.tmp`),
      join(home, '.gemini', 'antigravity', 'conversations', `${FIRST}.db`),
      `${paths.brain}/${FIRST}/../${SECOND}/.system_generated/logs/transcript.jsonl`,
      'relative/transcript.jsonl'
    ]) {
      expect(classifyAntigravityPath(paths, path)).toEqual({ kind: 'other' })
    }
  })

  it('names only paths the access gate allows', async () => {
    const paths = antigravityPaths(home)
    const gate = createAccessGate(home)
    for (const path of [transcriptPath(paths, FIRST), annotationPath(paths, FIRST)]) {
      await createFile(path)
      expect(classifyAntigravityPath(paths, path).kind).not.toBe('other')
      await expect(gate.resolve(path)).resolves.toBeTypeOf('string')
    }
  })
})

describe('listTranscripts', () => {
  it('lists conversation transcripts and skips folders without one', async () => {
    const paths = antigravityPaths(home)
    await createFile(transcriptPath(paths, FIRST))
    await createFile(transcriptPath(paths, SECOND))
    // A legacy conversation (no transcript), a non-conversation folder, and a stray file.
    await mkdir(join(paths.brain, '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'), { recursive: true })
    await createFile(
      join(paths.brain, 'tempmediaStorage', '.system_generated', 'logs', 'transcript.jsonl')
    )
    await createFile(join(paths.brain, 'notes.txt'))

    const files = await listTranscripts(paths)
    expect(files.map((file) => file.conversationId).sort()).toEqual([FIRST, SECOND].sort())
    for (const file of files) {
      expect(file.path).toBe(transcriptPath(paths, file.conversationId))
      expect(file.signature).toMatch(/^\d+:\d+:\d+:[\d.]+$/)
    }
  })

  it('does not follow a symlinked conversation folder or a transcript that is a folder', async () => {
    const paths = antigravityPaths(home)
    await createFile(join(root, 'elsewhere', '.system_generated', 'logs', 'transcript.jsonl'))
    await mkdir(paths.brain, { recursive: true })
    await symlink(join(root, 'elsewhere'), join(paths.brain, FIRST))
    await mkdir(transcriptPath(paths, SECOND), { recursive: true })
    expect(await listTranscripts(paths)).toEqual([])
  })

  it.each([
    ['.system_generated', ['.system_generated']],
    ['logs', ['.system_generated', 'logs']]
  ])('does not follow a symlinked %s folder out of brain', async (_, names) => {
    const paths = antigravityPaths(home)
    const outside = join(root, 'elsewhere')
    await createFile(
      join(outside, ...['.system_generated', 'logs'].slice(names.length), 'transcript.jsonl')
    )
    const link = join(paths.brain, FIRST, ...names)
    await mkdir(dirname(link), { recursive: true })
    await symlink(outside, link)
    await createFile(transcriptPath(paths, SECOND))
    expect((await listTranscripts(paths)).map((file) => file.conversationId)).toEqual([SECOND])
  })

  it('lets a missing brain folder reach the caller', async () => {
    await expect(listTranscripts(antigravityPaths(home))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('statTranscript', () => {
  it('stats one transcript with the listing checks', async () => {
    const paths = antigravityPaths(home)
    await createFile(transcriptPath(paths, FIRST))
    const [listed] = await listTranscripts(paths)
    expect(await statTranscript(paths, FIRST)).toEqual(listed)
    expect(await statTranscript(paths, SECOND)).toBeNull()
    for (const id of ['../..', FIRST.toUpperCase(), 'tempmediaStorage', '']) {
      expect(await statTranscript(paths, id)).toBeNull()
    }
  })

  it.each([[[]], [['.system_generated']], [['.system_generated', 'logs']]])(
    'does not follow a symlinked folder at depth %j',
    async (names) => {
      const paths = antigravityPaths(home)
      const outside = join(root, 'elsewhere')
      await createFile(
        join(outside, ...['.system_generated', 'logs'].slice(names.length), 'transcript.jsonl')
      )
      const link = join(paths.brain, FIRST, ...names)
      await mkdir(dirname(link), { recursive: true })
      await symlink(outside, link)
      expect(await statTranscript(paths, FIRST)).toBeNull()
    }
  )
})
