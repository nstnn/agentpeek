import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  utimes,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deriveAttention } from '../../core/attention'
import {
  annotationText,
  conversationId,
  finalReplyLine,
  MINUTE,
  SECOND,
  skillBlock,
  systemMessageLine,
  T0,
  toolRequestLine,
  toolResultLine,
  unknownStepLine,
  userInputLine
} from '../../core/antigravity/test-records'
import { EMPTY_LOCAL_STATE } from '../../core/session'
import { type AccessGate, createAccessGate } from './access'
import { annotationPath, antigravityPaths, transcriptPath } from './antigravity-files'
import {
  type AntigravityReader,
  type AntigravityReaderOptions,
  type AntigravitySourceOptions,
  createAntigravityReader,
  createAntigravitySource
} from './antigravity-source'
import type { SessionSource } from './session-source'

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

  it('finds a prefix prompt even when it falls outside the turn tail', async () => {
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
      'not json',
      userInputLine({ step: 0, text: 'Synthetic' }),
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

  it('reuses the classification and facts of an unchanged transcript', async () => {
    const path = await writeTranscript(1, finishedTurn())
    const reader = createReader()
    const first = await reader.catalog()
    // The first line and the tail.
    expect(opened.filter((item) => item === path)).toHaveLength(2)
    expect(await reader.catalog()).toEqual(first)
    expect(opened.filter((item) => item === path)).toHaveLength(2)
  })

  it('reaches a conversation behind cap-many subagents on the first listing', async () => {
    await writeTranscript(1, [systemMessageLine({ step: 0 })], NOW - MINUTE)
    await writeTranscript(2, [systemMessageLine({ step: 0 })], NOW - 2 * MINUTE)
    await writeTranscript(3, finishedTurn(), NOW - 3 * MINUTE)
    const reader = createReader({ range: () => ({ windowMs: DAY, maxPerTool: 2 }) })
    expect((await reader.catalog()).map(({ conversationId }) => conversationId)).toEqual([
      conversationId(3)
    ])
    expect(reader.olderAvailable()).toBe(false)
  })

  it('bounds the reads spent on rejected candidates and goes further on the next listing', async () => {
    // Cap 1: the budget is the minimum, 8 rejected candidates per listing.
    for (let n = 1; n <= 12; n++) {
      await writeTranscript(n, [toolResultLine({ step: 0 })], NOW - n * MINUTE)
    }
    await writeTranscript(13, finishedTurn(), NOW - 13 * MINUTE)
    const reader = createReader({ range: () => ({ windowMs: DAY, maxPerTool: 1 }) })
    expect(await reader.catalog()).toEqual([])
    expect(opened).toHaveLength(8)
    // Candidates left unread keep Load Older Sessions available.
    expect(reader.olderAvailable()).toBe(true)
    opened = []
    expect((await reader.catalog()).map(({ conversationId }) => conversationId)).toEqual([
      conversationId(13)
    ])
    // Only the 4 rejected candidates not read before, then the conversation (first line and tail).
    expect(opened).toHaveLength(6)
    expect(reader.olderAvailable()).toBe(false)
  })

  it('scales the rejected-candidate budget with the cap', async () => {
    // Cap 3: 4 per listed session, 12 rejected candidates in all.
    for (let n = 1; n <= 10; n++) {
      await writeTranscript(n, [systemMessageLine({ step: 0 })], NOW - n * MINUTE)
    }
    await writeTranscript(11, finishedTurn(), NOW - 11 * MINUTE)
    const reader = createReader({ range: () => ({ windowMs: DAY, maxPerTool: 3 }) })
    expect((await reader.catalog()).map(({ conversationId }) => conversationId)).toEqual([
      conversationId(11)
    ])
  })

  it('does not let an unreadable transcript hide a readable one', async () => {
    const unreadable = await writeTranscript(1, finishedTurn(), NOW - MINUTE)
    await writeTranscript(2, finishedTurn(), NOW - 2 * MINUTE)
    await chmod(unreadable, 0o000)
    const reader = createReader({ range: () => ({ windowMs: DAY, maxPerTool: 1 }) })
    expect((await reader.catalog()).map(({ conversationId }) => conversationId)).toEqual([
      conversationId(2)
    ])
    await chmod(unreadable, 0o600)
    expect(
      (await reader.refresh([unreadable])).map(({ conversationId }) => conversationId)
    ).toEqual([conversationId(1)])
  })

  it('keeps the older hint for omitted candidates and excludes known subagents', async () => {
    await writeTranscript(1, finishedTurn())
    await writeTranscript(2, [systemMessageLine({ step: 0 })], NOW - 4 * DAY)
    const reader = createReader({ range: () => ({ windowMs: DAY, maxPerTool: 1 }) })
    expect(await reader.catalog()).toHaveLength(1)
    expect(reader.olderAvailable()).toBe(false)
    const older = await writeTranscript(
      3,
      finishedTurn('Synthetic old prompt', NOW - 2 * DAY),
      NOW - 2 * DAY
    )
    const oldest = await writeTranscript(
      4,
      finishedTurn('Synthetic older prompt', NOW - 3 * DAY),
      NOW - 3 * DAY
    )
    const outsideLookahead = await writeTranscript(
      5,
      finishedTurn('Synthetic prompt beyond lookahead', NOW - 3.5 * DAY),
      NOW - 3.5 * DAY
    )
    expect(await reader.catalog()).toHaveLength(1)
    expect(reader.olderAvailable()).toBe(true)
    await rm(older)
    expect(await reader.refresh([older])).toHaveLength(1)
    expect(reader.olderAvailable()).toBe(true)
    await rm(oldest)
    expect(await reader.refresh([oldest])).toHaveLength(1)
    expect(reader.olderAvailable()).toBe(true)
    await rm(outsideLookahead)
    expect(await reader.refresh([outsideLookahead])).toHaveLength(1)
    expect(reader.olderAvailable()).toBe(false)
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

  it.each(['same-size', 'growing'])(
    'rebuilds the reply on a %s in-place rewrite',
    async (change) => {
      const prompt = userInputLine({ step: 0, text: 'Synthetic prompt' })
      const path = await writeTranscript(1, [prompt, finalReplyLine({ step: 1, text: 'First' })])
      const reader = createReader()
      const [before] = await reader.catalog()
      const changedAt = T0 + 2 * SECOND
      const rewritten = [prompt, finalReplyLine({ step: 1, at: changedAt, text: 'Other' })]
      if (change === 'growing')
        rewritten.push(userInputLine({ step: 2, text: 'Synthetic next prompt' }))
      await writeTranscript(1, rewritten, NOW)
      const [after] = await reader.refresh([path])
      expect(after?.lastReply?.cursor).not.toBe(before?.lastReply?.cursor)
      expect(after?.lastReply?.completedAt).toBe(changedAt)
    }
  )

  it('uses the new mtime when a changed transcript crosses the old cutoff', async () => {
    const old = NOW - 2 * DAY
    const path = await writeTranscript(
      1,
      [userInputLine({ step: 0, at: old, text: 'Synthetic' })],
      old
    )
    const options = { range: () => ({ windowMs: 3 * DAY, maxPerTool: 50 }) }
    const reader = createReader(options)
    expect(await reader.catalog()).toHaveLength(1)
    clock += 2 * DAY
    await appendFile(path, `${toolResultLine({ step: 1, at: old + SECOND })}\n`)
    await utimes(path, clock / 1000, clock / 1000)
    const after = await reader.refresh([path])
    expect(after[0]?.summary.lastActivityAt).toBe(clock)
    expect(after).toEqual(await createReader(options).catalog())
  })

  it('keeps a replayed reply suppressed after the later prompt is rolled back', async () => {
    const oldTurn = finishedTurn()
    const nextPrompt = userInputLine({ step: 4, text: 'Synthetic follow-up' })
    const path = await writeTranscript(1, [...oldTurn, nextPrompt])
    const reader = createReader()
    const [before] = await reader.catalog()
    expect(before?.lastReply?.newerTurnStarted).toBe(true)
    await writeFile(`${path}.new`, `${oldTurn.join('\n')}\n`)
    await rename(`${path}.new`, path)
    const [after] = await reader.refresh([path])
    expect(after?.lastReply?.cursor).toBe(before?.lastReply?.cursor)
    expect(
      deriveAttention({
        activity: { state: 'idle' },
        lastReply: after?.lastReply ?? null,
        local: EMPTY_LOCAL_STATE,
        baselineAt: T0 - SECOND
      }).newReply
    ).toBe(false)
    await appendFile(
      path,
      `${nextPrompt}\n${finalReplyLine({ step: 5, text: 'Synthetic new reply' })}\n`
    )
    const [resumed] = await reader.refresh([path])
    expect(resumed?.lastReply?.cursor).toMatch(/^5:/)
    expect(resumed?.lastReply?.newerTurnStarted).toBe(false)
  })
})

describe('skill', () => {
  const NAME = 'synthetic-pr'
  const skillPath = () => join(home, '.gemini', 'config', 'skills', NAME, 'SKILL.md')

  async function writeSkillPrompt(path: string): Promise<void> {
    await writeTranscript(1, [
      userInputLine({ step: 0, at: T0, text: `/${NAME} go`, metadata: skillBlock(NAME, path) }),
      finalReplyLine({ step: 1, at: T0 + SECOND, text: 'Synthetic answer' })
    ])
  }

  it('reads the SKILL.md a recent prompt asked for from Antigravity skills', async () => {
    await mkdir(dirname(skillPath()), { recursive: true })
    await writeFile(
      skillPath(),
      '---\nname: synthetic-pr\ndescription: Synthetic skill.\n---\n# Synthetic body'
    )
    await writeSkillPrompt(skillPath())
    const reader = createReader()
    await reader.catalog()
    expect(
      await reader.skill(conversationId(1), { at: T0, name: NAME, path: skillPath() })
    ).toEqual({
      kind: 'skill',
      source: 'local',
      text: '# Synthetic body',
      description: 'Synthetic skill.',
      truncated: false
    })
  })

  it('reads only what a listed prompt asked for, and never a project or other file', async () => {
    const project = join(root, 'project', '.agents', 'skills', NAME, 'SKILL.md')
    await mkdir(dirname(project), { recursive: true })
    await writeFile(project, '# Synthetic project skill')
    await writeSkillPrompt(project)
    const reader = createReader()
    await reader.catalog()
    expect(await reader.skill(conversationId(1), { at: T0, name: NAME, path: project })).toEqual({
      kind: 'unavailable',
      reason: 'not-allowed'
    })
    for (const request of [
      { at: T0 + 1, name: NAME, path: project },
      { at: T0, name: 'other-skill', path: project },
      { at: T0, name: NAME, path: skillPath() }
    ]) {
      expect(await reader.skill(conversationId(1), request)).toEqual({
        kind: 'unavailable',
        reason: 'not-found'
      })
    }
    expect(await reader.skill(conversationId(2), { at: T0, name: NAME, path: project })).toEqual({
      kind: 'unavailable',
      reason: 'not-found'
    })
  })

  it('reports a missing skill file as not found', async () => {
    await writeSkillPrompt(skillPath())
    const source = createAntigravitySource({
      home,
      gate,
      now: () => clock,
      isAppRunning: () => Promise.resolve(false)
    })
    await source.catalog()
    const request = { at: T0, name: NAME, path: skillPath() }
    expect(await source.getSkill!({ tool: 'antigravity', id: conversationId(1) }, request)).toEqual(
      { kind: 'unavailable', reason: 'not-found' }
    )
    expect(await source.getSkill!({ tool: 'codex', id: conversationId(1) }, request)).toEqual({
      kind: 'unavailable',
      reason: 'not-found'
    })
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
        {
          kind: 'tool-calls',
          count: 1,
          names: ['read_file'],
          at: T0 + SECOND,
          calls: [expect.objectContaining({ name: 'read_file', status: 'done' })]
        },
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

  it.each(['replacement', 'in-place rewrite'])(
    'rechecks eligibility after a subagent %s',
    async (change) => {
      const path = await writeTranscript(1, finishedTurn())
      const reader = createReader()
      expect(await reader.catalog()).toHaveLength(1)
      const child = `${systemMessageLine({ step: 0 })}\n${finalReplyLine({ step: 1, text: 'Synthetic subagent reply' })}\n`
      if (change === 'replacement') {
        await writeFile(`${path}.new`, child)
        await rename(`${path}.new`, path)
      } else {
        await writeFile(path, child)
      }
      expect(await reader.recentMessages(conversationId(1), 10)).toEqual({ kind: 'not-found' })
      expect(
        change === 'replacement' ? await reader.refresh([path]) : await reader.catalog()
      ).toEqual([])
    }
  )

  it('refuses a symlink to a different UUID after the original was listed', async () => {
    const path = await writeTranscript(1, finishedTurn())
    const other = await writeTranscript(2, finishedTurn('Synthetic different prompt'))
    const reader = createReader()
    expect(await reader.catalog()).toHaveLength(2)
    await rm(path)
    await symlink(other, path)
    opened = []
    expect(await reader.recentMessages(conversationId(1), 10)).toEqual({ kind: 'unreadable' })
    expect((await reader.refresh([path])).map(({ conversationId }) => conversationId)).toEqual([
      conversationId(2)
    ])
    expect(opened).toEqual([])
  })

  it('checks the opened file still matches the classified transcript', async () => {
    const path = await writeTranscript(1, finishedTurn())
    const other = await writeTranscript(2, finishedTurn('Synthetic different prompt'))
    let redirect = false
    const reader = createReader({
      gate: {
        resolve: (candidate) => gate.resolve(candidate),
        open: (candidate) => gate.open(redirect && candidate === path ? other : candidate)
      }
    })
    expect(await reader.catalog()).toHaveLength(2)
    redirect = true
    expect(await reader.recentMessages(conversationId(1), 10)).toEqual({ kind: 'unreadable' })
  })

  it('ignores unobserved source and type pairs in facts and detail', async () => {
    const wrongSource = (line: string): string =>
      JSON.stringify({ ...JSON.parse(line), source: 'SYSTEM' })
    const path = await writeTranscript(1, [
      userInputLine({ step: 0, text: 'Synthetic prompt' }),
      wrongSource(finalReplyLine({ step: 20, text: 'Synthetic non-model reply' }))
    ])
    const reader = createReader()
    expect((await reader.catalog())[0]).toMatchObject({ lastTurnStep: 'open', lastReply: null })
    await appendFile(
      path,
      [
        finalReplyLine({ step: 2, text: 'Synthetic valid reply' }),
        wrongSource(toolResultLine({ step: 3 })),
        ''
      ].join('\n')
    )
    expect((await reader.refresh([path]))[0]).toMatchObject({ lastTurnStep: 'ended' })
    expect(await reader.recentMessages(conversationId(1), 10)).toMatchObject({
      messages: [{ kind: 'prompt' }, { kind: 'reply', text: 'Synthetic valid reply' }]
    })
  })

  it('ignores unknown statuses and malformed tool-call payloads', async () => {
    const reader = createReader()
    const path = await writeTranscript(1, [
      ...finishedTurn(),
      toolResultLine({ step: 4, status: 'FUTURE' })
    ])
    const [before] = await reader.catalog()
    expect(before?.lastTurnStep).toBe('ended')
    const malformed = JSON.parse(
      finalReplyLine({ step: 6, text: 'Synthetic invalid reply' })
    ) as Record<string, unknown>
    malformed.tool_calls = { unexpectedShape: true }
    await appendFile(
      path,
      `${userInputLine({ step: 5, text: 'Synthetic follow-up' })}\n${JSON.stringify(malformed)}\n`
    )
    const [after] = await reader.refresh([path])
    expect(after?.lastTurnStep).toBe('open')
    expect(after?.lastReply?.cursor).toBe(before?.lastReply?.cursor)
    expect(JSON.stringify(await reader.recentMessages(conversationId(1), 10))).not.toContain(
      'Synthetic invalid reply'
    )
  })

  it('uses mtime for an unknown timestamp encoding with a stable reply cursor', async () => {
    const mtime = NOW - MINUTE
    const path = await writeTranscript(
      1,
      [
        userInputLine({ step: 0, text: 'Synthetic prompt' }),
        finalReplyLine({ step: 1, text: 'Synthetic reply', createdAt: { futureEncoding: 1 } })
      ],
      mtime
    )
    const reader = createReader()
    const [before] = await reader.catalog()
    expect(before?.lastReply?.cursor).toMatch(/^1:/)
    expect(before?.lastReply?.completedAt).toBe(mtime)
    expect(before?.lastReply?.completedAtEstimated).toBe(true)
    expect(await reader.recentMessages(conversationId(1), 1)).toMatchObject({
      messages: [{ kind: 'reply', at: mtime }]
    })
    await appendFile(path, `${unknownStepLine({ step: 2 })}\n`)
    await utimes(path, NOW / 1000, NOW / 1000)
    const [after] = await reader.refresh([path])
    expect(after?.lastReply?.cursor).toBe(before?.lastReply?.cursor)
    expect(after?.lastReply?.completedAt).toBe(mtime)
    const [reopened] = await createReader().catalog()
    expect(reopened?.lastReply?.cursor).toBe(before?.lastReply?.cursor)
    expect(reopened?.lastReply?.completedAt).toBe(NOW)
    expect(
      deriveAttention({
        activity: { state: 'idle' },
        lastReply: reopened?.lastReply ?? null,
        local: EMPTY_LOCAL_STATE,
        baselineAt: NOW - SECOND
      }).newReply
    ).toBe(false)
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

describe('createAntigravitySource (TASK-005)', () => {
  let appChecks: number
  let appRunning: boolean

  beforeEach(() => {
    appChecks = 0
    appRunning = true
  })

  function createSource(options: Partial<AntigravitySourceOptions> = {}): SessionSource {
    return createAntigravitySource({
      home,
      gate,
      now: () => clock,
      isAppRunning: () => {
        appChecks++
        return Promise.resolve(appRunning)
      },
      ...options
    })
  }

  function openTurn(at = NOW - 2 * MINUTE): string[] {
    return [
      userInputLine({ step: 0, at, text: 'Synthetic question' }),
      toolRequestLine({ step: 1, at: at + SECOND, tools: ['run_command'] })
    ]
  }

  it('reports Antigravity facts under the conversation ID, with no watched files', async () => {
    await writeTranscript(1, finishedTurn('Synthetic question', NOW - 5 * MINUTE), NOW - MINUTE)
    await writeAnnotation(1, annotationText('Synthetic title'))
    const source = createSource()
    expect(source.tool).toBe('antigravity')
    const [facts] = await source.catalog()
    expect(facts).toEqual({
      key: { tool: 'antigravity', id: conversationId(1) },
      summary: {
        title: 'Synthetic title',
        workspacePath: null,
        lastActivityAt: NOW - MINUTE,
        toolVersion: null
      },
      turn: { kind: 'antigravity', lastTurnStep: 'ended', appRunning: false },
      lastReply: {
        cursor: `3:${new Date(NOW - 5 * MINUTE + 3 * SECOND).toISOString()}`,
        completedAt: NOW - 5 * MINUTE + 3 * SECOND,
        isError: false,
        errorCode: null,
        newerTurnStarted: false
      }
    })
    expect(source.watchedFiles()).toEqual([])
    expect(source.health()).toEqual({ state: 'connected', lastReadAt: NOW })
    // Nothing was open, so the app was never checked.
    expect(appChecks).toBe(0)
  })

  it('checks the app only for an open turn, and reuses the answer for a few seconds', async () => {
    await writeTranscript(1, openTurn())
    const source = createSource()
    appRunning = false
    const [facts] = await source.catalog()
    expect(facts?.turn).toEqual({ kind: 'antigravity', lastTurnStep: 'open', appRunning: false })
    expect(appChecks).toBe(1)
    appRunning = true
    clock += SECOND
    await source.refresh([])
    expect(appChecks).toBe(1)
    clock += 5 * SECOND
    const [later] = await source.refresh([])
    expect(appChecks).toBe(2)
    expect(later?.turn).toEqual({ kind: 'antigravity', lastTurnStep: 'open', appRunning: true })
  })

  it('does not report running on a failed app check and retries after the cache expires', async () => {
    await writeTranscript(1, openTurn())
    const isAppRunning = vi.fn<() => Promise<boolean>>()
    isAppRunning.mockRejectedValueOnce(new Error('lsappinfo')).mockResolvedValue(true)
    const source = createSource({ isAppRunning })
    const [facts] = await source.catalog()
    expect(facts?.turn).toEqual({ kind: 'antigravity', lastTurnStep: 'open', appRunning: false })
    clock += 5 * SECOND
    const [retried] = await source.refresh([])
    expect(retried?.turn).toEqual({ kind: 'antigravity', lastTurnStep: 'open', appRunning: true })
  })

  it('maps an unreadable transcript to unreadable turn facts without a reply', async () => {
    await writeTranscript(1, finishedTurn('Synthetic question', NOW - 5 * MINUTE), NOW - MINUTE)
    const source = createSource()
    expect((await source.catalog())[0]?.lastReply).not.toBeNull()
    // The same file can no longer be opened: the row stays, unreadable, with no reply.
    const path = transcriptPath(paths, conversationId(1))
    await chmod(path, 0o000)
    try {
      const [facts] = await source.refresh([path])
      expect(facts?.turn).toEqual({ kind: 'unreadable' })
      expect(facts?.lastReply).toBeNull()
    } finally {
      await chmod(path, 0o644)
    }
  })

  it('refreshes a changed path, a replaced file, and a resumed older conversation', async () => {
    const path = await writeTranscript(1, openTurn(NOW - 3 * MINUTE), NOW - 3 * MINUTE)
    // An older conversation, outside the 7-day range until it is resumed.
    const old = await writeTranscript(2, finishedTurn('Old', NOW - 9 * DAY), NOW - 9 * DAY)
    const source = createSource()
    expect((await source.catalog()).map((facts) => facts.key.id)).toEqual([conversationId(1)])
    expect(source.olderAvailable()).toBe(true)

    // An append finishes the open turn.
    await appendFile(path, `${finalReplyLine({ step: 2, at: NOW - MINUTE, text: 'Done' })}\n`)
    await utimes(path, (NOW - MINUTE) / 1000, (NOW - MINUTE) / 1000)
    const [appended] = await source.refresh([path])
    expect(appended?.turn).toEqual({ kind: 'antigravity', lastTurnStep: 'ended', appRunning: true })
    const cursor = appended?.lastReply?.cursor
    expect(cursor).toEqual(expect.any(String))

    // A replacement (a new inode) with a new open turn.
    const replacement = `${path}.synthetic-new`
    await writeFile(
      replacement,
      [...openTurn(NOW - 3 * MINUTE), userInputLine({ step: 3, at: NOW, text: 'Again' })]
        .map((line) => `${line}\n`)
        .join('')
    )
    await rename(replacement, path)
    const [replaced] = await source.refresh([path])
    expect(replaced?.turn).toEqual({ kind: 'antigravity', lastTurnStep: 'open', appRunning: true })

    // The older conversation is resumed: its next step brings it into the range.
    await appendFile(old, `${userInputLine({ step: 4, at: NOW, text: 'Resume' })}\n`)
    await utimes(old, NOW / 1000, NOW / 1000)
    const resumed = await source.refresh([old])
    expect(resumed.map((facts) => facts.key.id).sort()).toEqual(
      [conversationId(1), conversationId(2)].sort()
    )
    const resumedFacts = resumed.find((facts) => facts.key.id === conversationId(2))
    expect(resumedFacts?.turn).toEqual({
      kind: 'antigravity',
      lastTurnStep: 'open',
      appRunning: true
    })
    // The resumed conversation's earlier reply was seen in Antigravity: a newer turn started.
    expect(resumedFacts?.lastReply?.newerTurnStarted).toBe(true)
  })

  it('finishes reads in the order they were asked for, even when an app check is slow', async () => {
    const path = await writeTranscript(1, openTurn())
    let release: (running: boolean) => void = () => undefined
    let calls = 0
    const source = createSource({
      isAppRunning: () => {
        calls++
        // The first check hangs until released; later ones answer at once.
        return calls === 1
          ? new Promise<boolean>((resolve) => {
              release = resolve
            })
          : Promise.resolve(true)
      }
    })
    const order: string[] = []
    const first = source.catalog().then(() => order.push('catalog'))
    await vi.waitFor(() => expect(calls).toBe(1))
    await appendFile(path, `${finalReplyLine({ step: 2, at: NOW, text: 'Done' })}\n`)
    const second = source.refresh([path]).then((facts) => {
      order.push('refresh')
      return facts
    })
    // The refresh waits for the catalog's app check instead of overtaking it.
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(order).toEqual([])
    release(false)
    await first
    const latest = await second
    expect(order).toEqual(['catalog', 'refresh'])
    expect(latest[0]?.turn).toEqual({
      kind: 'antigravity',
      lastTurnStep: 'ended',
      appRunning: false
    })
  })

  it('answers detail only for Antigravity keys of listed conversations', async () => {
    await writeTranscript(1, finishedTurn('Synthetic question', NOW - 5 * MINUTE), NOW - MINUTE)
    const source = createSource()
    await source.catalog()
    const id = conversationId(1)
    expect((await source.recentMessages({ tool: 'antigravity', id }, 20)).kind).toBe('messages')
    expect(await source.recentMessages({ tool: 'codex', id }, 20)).toEqual({ kind: 'not-found' })
    expect(await source.recentMessages({ tool: 'antigravity', id: conversationId(9) }, 20)).toEqual(
      { kind: 'not-found' }
    )
  })
})
