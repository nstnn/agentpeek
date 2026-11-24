import { appendFile, chmod, mkdir, mkdtemp, rename, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  annotationText,
  conversationId,
  finalReplyLine,
  MINUTE,
  SECOND,
  systemMessageLine,
  T0,
  toolRequestLine,
  toolResultLine,
  unknownStepLine,
  userInputLine
} from '../../core/antigravity/test-records'
import { type AccessGate, createAccessGate } from './access'
import { annotationPath, antigravityPaths, transcriptPath } from './antigravity-files'
import {
  type AntigravityReader,
  type AntigravityReaderOptions,
  createAntigravityReader
} from './antigravity-source'

// Synthetic files only, in a temporary folder that stands in for the home folder. The clock is
// fixed one hour after the synthetic records start.
const NOW = T0 + 60 * MINUTE
const DAY = 24 * 60 * MINUTE

let root: string
let home: string
let paths: ReturnType<typeof antigravityPaths>
let opened: string[]
let gate: AccessGate
let clock: number

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agentpeek-antigravity-source-'))
  home = join(root, 'home')
  paths = antigravityPaths(home)
  await mkdir(paths.brain, { recursive: true })
  await mkdir(paths.annotations, { recursive: true })
  const realGate = createAccessGate(home)
  opened = []
  gate = {
    resolve: (path) => realGate.resolve(path),
    open: (path) => {
      opened.push(path)
      return realGate.open(path)
    }
  }
  clock = NOW
})

afterEach(async () => {
  await chmod(paths.brain, 0o755).catch(() => undefined)
  await rm(root, { recursive: true, force: true })
})

function createReader(options: Partial<AntigravityReaderOptions> = {}): AntigravityReader {
  return createAntigravityReader({ home, gate, now: () => clock, ...options })
}

/** Writes a transcript whose modification time is `at`. */
async function writeTranscript(n: number, lines: string[], at = NOW - MINUTE): Promise<string> {
  const path = transcriptPath(paths, conversationId(n))
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, lines.map((line) => `${line}\n`).join(''))
  await utimes(path, at / 1000, at / 1000)
  return path
}

async function writeAnnotation(n: number, text: string): Promise<string> {
  const path = annotationPath(paths, conversationId(n))
  await writeFile(path, text)
  return path
}

/** A finished one-turn conversation starting at `at`. */
function finishedTurn(text = 'Synthetic question', at = T0): string[] {
  return [
    userInputLine({ step: 0, at, text }),
    toolRequestLine({ step: 1, at: at + SECOND, tools: ['read_file'] }),
    toolResultLine({ step: 2, at: at + 2 * SECOND }),
    finalReplyLine({ step: 3, at: at + 3 * SECOND, text: 'Synthetic answer' })
  ]
}

describe('catalog', () => {
  it('lists user conversations newest first and leaves out subagents, legacy and other folders', async () => {
    await writeTranscript(1, finishedTurn(), NOW - 10 * MINUTE)
    await writeTranscript(2, finishedTurn(), NOW - 2 * MINUTE)
    // A subagent transcript starts with a system message.
    await writeTranscript(3, [
      systemMessageLine({ step: 0 }),
      finalReplyLine({ step: 1, text: 'x' })
    ])
    // A legacy conversation has a folder but no transcript.
    await mkdir(join(paths.brain, conversationId(4)))
    await mkdir(join(paths.brain, 'tempmediaStorage', '.system_generated', 'logs'), {
      recursive: true
    })
    // A first step of another kind is listed only when the tail holds a user prompt.
    await writeTranscript(
      5,
      [unknownStepLine({ step: 0 }), userInputLine({ step: 1, text: 'Hi' })],
      NOW - 20 * MINUTE
    )
    await writeTranscript(6, [unknownStepLine({ step: 0 }), toolResultLine({ step: 1 })])

    const reader = createReader()
    const facts = await reader.catalog()
    expect(facts.map((fact) => fact.conversationId)).toEqual([
      conversationId(2),
      conversationId(1),
      conversationId(5)
    ])
    expect(facts[0]).toEqual({
      conversationId: conversationId(2),
      summary: {
        title: null,
        workspacePath: null,
        lastActivityAt: NOW - 2 * MINUTE,
        toolVersion: null
      },
      fileStatus: 'read',
      lastTurnStep: 'ended',
      lastReply: {
        cursor: `3:${new Date(T0 + 3 * SECOND).toISOString()}`,
        completedAt: T0 + 3 * SECOND,
        isError: false,
        errorCode: null,
        newerTurnStarted: false
      }
    })
    expect(facts[2]).toMatchObject({ lastTurnStep: 'open', lastReply: null })
    expect(reader.health()).toEqual({ state: 'connected', lastReadAt: NOW })
    // Every open went through the gate, to a transcript or an annotation only.
    for (const path of opened) expect(path).toMatch(/transcript\.jsonl$|\.pbtxt$/)
  })

  it('keeps the range and the cap, lists saved pins beyond them, and reports older ones', async () => {
    await writeTranscript(1, finishedTurn(), NOW - MINUTE)
    await writeTranscript(2, finishedTurn(), NOW - 2 * MINUTE)
    await writeTranscript(3, finishedTurn(), NOW - 3 * MINUTE)
    await writeTranscript(4, finishedTurn(), NOW - 8 * DAY)
    const capped = createReader({ range: () => ({ windowMs: 7 * DAY, maxPerTool: 2 }) })
    expect((await capped.catalog()).map((fact) => fact.conversationId)).toEqual([
      conversationId(1),
      conversationId(2)
    ])
    expect(capped.olderAvailable()).toBe(true)

    const pinned = createReader({ pinnedIds: () => [conversationId(4)] })
    expect((await pinned.catalog()).map((fact) => fact.conversationId)).toEqual([
      conversationId(1),
      conversationId(2),
      conversationId(3),
      conversationId(4)
    ])
    expect(pinned.olderAvailable()).toBe(false)

    const wide = createReader({ range: () => ({ windowMs: 30 * DAY, maxPerTool: 50 }) })
    expect(await wide.catalog()).toHaveLength(4)
    expect(wide.olderAvailable()).toBe(false)
  })

  it('widens the tail to find a user prompt when the first step is another kind', async () => {
    const filler = Array.from({ length: 120 }, (_, i) =>
      toolRequestLine({
        step: i + 2,
        at: T0 + (i + 2) * SECOND,
        tools: ['read_file'],
        commentary: 'x'.repeat(3000)
      })
    )
    const lines = [
      unknownStepLine({ step: 0, at: T0 }),
      userInputLine({ step: 1, at: T0 + SECOND, text: 'Synthetic prompt beyond 256 KiB' }),
      ...filler,
      finalReplyLine({ step: filler.length + 2, at: T0 + 200 * SECOND, text: 'Synthetic done' })
    ]
    await writeTranscript(1, lines, NOW - MINUTE)
    const facts = await createReader().catalog()
    expect(facts.map((fact) => fact.conversationId)).toEqual([conversationId(1)])
    expect(facts[0]).toMatchObject({ fileStatus: 'read', lastTurnStep: 'ended' })
  })

  it('reads the title from the annotation and falls back when it is missing or unusable', async () => {
    await writeTranscript(1, finishedTurn())
    await writeTranscript(2, finishedTurn())
    await writeTranscript(3, finishedTurn())
    await writeTranscript(4, finishedTurn())
    await writeAnnotation(1, annotationText('Synthetic title'))
    await writeAnnotation(2, 'not text format "')
    await writeAnnotation(3, `title: "${'x'.repeat(70 * 1024)}"`)
    // An orphan annotation never lists a conversation.
    await writeAnnotation(9, annotationText('Orphan'))

    const facts = await createReader().catalog()
    const titles = Object.fromEntries(
      facts.map((fact) => [fact.conversationId, fact.summary.title])
    )
    expect(titles).toEqual({
      [conversationId(1)]: 'Synthetic title',
      [conversationId(2)]: null,
      [conversationId(3)]: null,
      [conversationId(4)]: null
    })
    expect(opened).not.toContain(annotationPath(paths, conversationId(9)))
  })

  it('skips malformed and unfinished lines without losing the conversation', async () => {
    const path = await writeTranscript(1, [
      userInputLine({ step: 0, text: 'Synthetic' }),
      'not json',
      '{"step_index": 1, "type": "GENERIC"}',
      finalReplyLine({ step: 2, text: 'Synthetic answer' })
    ])
    // A step still being written has no line end yet.
    await appendFile(path, '{"step_index": 3, "type": "USER_IN')
    const [fact] = await createReader().catalog()
    expect(fact).toMatchObject({ fileStatus: 'read', lastTurnStep: 'ended' })
    expect(fact?.lastReply?.cursor).toMatch(/^2:/)
  })

  it('reports an unsupported format and a missing or unreadable folder', async () => {
    await writeTranscript(1, [JSON.stringify({ step: 0, kind: 'future' })])
    const reader = createReader()
    expect(await reader.catalog()).toEqual([])
    expect(reader.health()).toEqual({ state: 'unsupported', toolVersion: null })

    await chmod(paths.brain, 0o000)
    expect(await reader.catalog()).toEqual([])
    expect(reader.health()).toMatchObject({ state: 'no-access' })
    await chmod(paths.brain, 0o755)

    await rm(join(home, '.gemini'), { recursive: true })
    const missing = createReader()
    expect(await missing.catalog()).toEqual([])
    expect(missing.health()).toEqual({ state: 'not-installed' })
  })

  it('reads a transcript once and then only what was appended', async () => {
    const path = await writeTranscript(1, finishedTurn())
    const reader = createReader()
    const first = await reader.catalog()
    // The first line and the tail.
    expect(opened.filter((item) => item === path)).toHaveLength(2)
    expect(await reader.catalog()).toEqual(first)
    expect(opened.filter((item) => item === path)).toHaveLength(3)
  })
})

describe('refresh', () => {
  it('keeps the reply identity across appends and rereads, and finds the next reply', async () => {
    const path = await writeTranscript(1, finishedTurn())
    const reader = createReader()
    const [before] = await reader.catalog()
    const cursor = before?.lastReply?.cursor

    await appendFile(path, `${userInputLine({ step: 4, at: T0 + 10 * SECOND, text: 'Next' })}\n`)
    const [open] = await reader.refresh([path])
    expect(open).toMatchObject({ lastTurnStep: 'open' })
    expect(open?.lastReply).toMatchObject({ cursor, newerTurnStarted: true })

    // A fresh reader reads the same tail and gets the same identity.
    const [reread] = await createReader().catalog()
    expect(reread?.lastReply).toEqual(open?.lastReply)

    await appendFile(
      path,
      `${toolRequestLine({ step: 5, at: T0 + 11 * SECOND, tools: ['run_command'] })}\n` +
        `${unknownStepLine({ step: 6, at: T0 + 12 * SECOND })}\n`
    )
    // An unknown step does not change the turn.
    expect((await reader.refresh([path]))[0]).toMatchObject({ lastTurnStep: 'open' })
    await appendFile(path, `${finalReplyLine({ step: 7, at: T0 + 13 * SECOND, text: 'Two' })}\n`)
    const [after] = await reader.refresh([path])
    expect(after?.lastReply).toMatchObject({
      cursor: `7:${new Date(T0 + 13 * SECOND).toISOString()}`,
      newerTurnStarted: false
    })
  })

  it('finds a new conversation, updates its title, and ignores other paths', async () => {
    const reader = createReader()
    expect(await reader.catalog()).toEqual([])
    const path = await writeTranscript(1, finishedTurn())
    const facts = await reader.refresh([path, join(paths.brain, conversationId(1)), '/tmp/other'])
    expect(facts.map((fact) => fact.conversationId)).toEqual([conversationId(1)])

    const annotation = await writeAnnotation(1, annotationText('Synthetic later title'))
    expect((await reader.refresh([annotation]))[0]?.summary.title).toBe('Synthetic later title')

    // A subagent reported by the watcher is not listed.
    const child = await writeTranscript(2, [systemMessageLine({ step: 0 })])
    expect(await reader.refresh([child])).toHaveLength(1)

    opened = []
    await reader.refresh(['/tmp/other', join(paths.annotations, 'notes.txt')])
    expect(opened).toEqual([])
  })

  it('rereads a replaced transcript and drops one that disappeared', async () => {
    const path = await writeTranscript(1, finishedTurn())
    const reader = createReader()
    await reader.catalog()

    // Replace the file (a new inode) with an open turn.
    const replacement = `${path}.new`
    await writeFile(replacement, `${userInputLine({ step: 0, text: 'Replaced' })}\n`)
    await rename(replacement, path)
    expect((await reader.refresh([path]))[0]).toMatchObject({
      lastTurnStep: 'open',
      lastReply: null
    })

    await rm(path)
    expect(await reader.refresh([path])).toEqual([])
  })
})

describe('recentMessages', () => {
  it('returns the newest prompts, replies and tool groups within the limit', async () => {
    await writeTranscript(1, [
      ...finishedTurn('Synthetic one'),
      userInputLine({ step: 4, at: T0 + 10 * SECOND, text: 'Synthetic two' }),
      finalReplyLine({
        step: 5,
        at: T0 + 11 * SECOND,
        text: 'Synthetic reply two',
        truncated: ['content']
      })
    ])
    const reader = createReader()
    await reader.catalog()
    const all = await reader.recentMessages(conversationId(1), 50)
    expect(all).toEqual({
      kind: 'messages',
      messages: [
        { kind: 'prompt', text: 'Synthetic one', at: T0 },
        { kind: 'tool-calls', count: 1, names: ['read_file'], at: T0 + SECOND },
        { kind: 'reply', text: 'Synthetic answer', at: T0 + 3 * SECOND },
        { kind: 'prompt', text: 'Synthetic two', at: T0 + 10 * SECOND },
        { kind: 'reply', text: 'Synthetic reply two', at: T0 + 11 * SECOND, truncated: true }
      ],
      hasOlder: false
    })
    const two = await reader.recentMessages(conversationId(1), 2)
    expect(two).toMatchObject({ kind: 'messages', hasOlder: true })
    expect(two.kind === 'messages' && two.messages.map((message) => message.kind)).toEqual([
      'prompt',
      'reply'
    ])
    expect(await reader.recentMessages(conversationId(1), Number.NaN)).toMatchObject({
      messages: []
    })
  })

  it('answers not-found for unlisted conversations and unreadable for a refused file', async () => {
    await writeTranscript(1, finishedTurn())
    await writeTranscript(2, [systemMessageLine({ step: 0 })])
    const reader = createReader()
    await reader.catalog()
    expect(await reader.recentMessages(conversationId(2), 10)).toEqual({ kind: 'not-found' })
    expect(await reader.recentMessages('../../etc', 10)).toEqual({ kind: 'not-found' })

    await chmod(transcriptPath(paths, conversationId(1)), 0o000)
    expect(await reader.recentMessages(conversationId(1), 10)).toEqual({ kind: 'unreadable' })
  })
})

describe('privacy', () => {
  it('keeps conversation text out of facts and logs', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined)
    )
    const path = await writeTranscript(1, finishedTurn('Synthetic private prompt'))
    await writeAnnotation(1, annotationText('Synthetic title'))
    const reader = createReader()
    const facts = [...(await reader.catalog()), ...(await reader.refresh([path]))]
    await reader.recentMessages(conversationId(1), 10)
    const serialized = JSON.stringify({ facts, health: reader.health() })
    for (const text of [
      'Synthetic private prompt',
      'Synthetic answer',
      'thinking',
      'tool output'
    ]) {
      expect(serialized).not.toContain(text)
    }
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled()
      spy.mockRestore()
    }
  })
})
