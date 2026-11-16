import {
  appendFile,
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  utimes,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  apiErrorLine,
  assistantLine,
  catalogJson,
  customTitleLine,
  CWD,
  CWD_FOLDER,
  interruptLine,
  MINUTE,
  metaUserLine,
  promptLine,
  registryJson,
  type RegistryOptions,
  SECOND,
  syntheticId,
  T0,
  toolResultLine,
  VERSION
} from '../../core/claude/test-records'
import type { SessionFacts, ToolCallDetail } from '../../core/session'
import { type AccessGate, createAccessGate } from './access'
import { claudePaths } from './claude-files'
import type { ProcessProbe } from './claude-process'
import { type ClaudeSourceOptions, createClaudeSource } from './claude-source'
import type { SessionSource } from './session-source'

// Synthetic files only, in a temporary folder that stands in for the home folder. The clock is
// fixed one hour after the synthetic records start.
const NOW = T0 + 60 * MINUTE
const DAY = 24 * 60 * MINUTE
const FIXTURE = join(import.meta.dirname, 'fixtures', 'claude-2.1.295')
const STOP = '[Request interrupted by user]'
const DENIED = '[Request interrupted by user for tool use]'

let root: string
let home: string
let paths: ReturnType<typeof claudePaths>
let opened: string[]
let gate: AccessGate
let clock: number
let alive: ReturnType<typeof vi.fn<ProcessProbe['isAlive']>>

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agentpeek-claude-source-'))
  home = join(root, 'home')
  paths = claudePaths(home)
  await mkdir(paths.registry, { recursive: true })
  await mkdir(paths.projects, { recursive: true })
  await mkdir(paths.catalog, { recursive: true })
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
  alive = vi.fn<ProcessProbe['isAlive']>(() => Promise.resolve(true))
})

afterEach(async () => {
  for (const folder of [paths.registry, paths.catalog, paths.projects]) {
    await chmod(folder, 0o755).catch(() => undefined)
  }
  await rm(root, { recursive: true, force: true })
})

function createSource(options: Partial<ClaudeSourceOptions> = {}): SessionSource {
  return createClaudeSource({ home, gate, probe: { isAlive: alive }, now: () => clock, ...options })
}

async function setModified(path: string, modifiedAt: number): Promise<void> {
  await utimes(path, modifiedAt / 1000, modifiedAt / 1000)
}

/** Writes a transcript in the folder for `CWD`. Its file time defaults to a minute ago. */
async function writeTranscript(
  sessionId: string,
  lines: readonly string[],
  modifiedAt = NOW - MINUTE,
  folder = CWD_FOLDER
): Promise<string> {
  const path = join(paths.projects, folder, `${sessionId}.jsonl`)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, lines.map((line) => `${line}\n`).join(''))
  await setModified(path, modifiedAt)
  return path
}

async function append(path: string, lines: readonly string[]): Promise<void> {
  await appendFile(path, lines.map((line) => `${line}\n`).join(''))
  await setModified(path, clock)
}

let catalogCount = 0

/** Writes a catalog file. Its name holds Claude.app's own ID, not the CLI session ID. */
async function writeCatalog(
  options: Parameters<typeof catalogJson>[0],
  modifiedAt = NOW - MINUTE,
  folders: readonly [string, string] = ['account', 'organization']
): Promise<string> {
  catalogCount++
  const path = join(paths.catalog, ...folders, `local_${syntheticId(0xd00 + catalogCount)}.json`)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, catalogJson({ lastActivityAt: NOW - MINUTE, ...options }))
  await setModified(path, modifiedAt)
  return path
}

async function writeRegistry(options: RegistryOptions): Promise<string> {
  const path = join(paths.registry, `${options.pid}.json`)
  await writeFile(path, registryJson(options))
  return path
}

/** A session whose single turn ended with a final reply. */
function finishedSession(replyUuid: string, start = T0): string[] {
  return [
    promptLine('Synthetic prompt.', start + SECOND),
    assistantLine([{ type: 'tool_use', name: 'Read' }], start + 2 * SECOND, {
      stopReason: 'tool_use'
    }),
    toolResultLine(start + 3 * SECOND),
    assistantLine([{ type: 'text', text: 'Synthetic answer.' }], start + 4 * SECOND, {
      uuid: replyUuid
    })
  ]
}

/** A call whose recorded input is an empty object, as in the synthetic records. */
function emptyCall(name: string, at: number, result: Partial<ToolCallDetail>): ToolCallDetail {
  return { name, at, input: '', inputLength: 0, nestedNames: null, summary: null, ...result }
}

function ids(facts: readonly SessionFacts[]): string[] {
  return facts.map((fact) => fact.key.id)
}

function byId(facts: readonly SessionFacts[], id: string): SessionFacts | undefined {
  return facts.find((fact) => fact.key.id === id)
}

const S1 = syntheticId(1)
const S2 = syntheticId(2)
const S3 = syntheticId(3)
const R1 = syntheticId(0x101)
const R2 = syntheticId(0x102)

describe('on-demand Claude skills', () => {
  it('keeps skill bodies out of facts/messages and reauthorizes each transcript read', async () => {
    const path = join(home, '.claude', 'skills', 'synthetic-skill', 'SKILL.md')
    const command =
      '<command-message>synthetic-skill</command-message>\n<command-name>/synthetic-skill</command-name>\n<command-args>Explain the synthetic change.</command-args>'
    const transcript = await writeTranscript(S1, [
      promptLine(command, T0),
      metaUserLine(
        `Base directory for this skill: ${dirname(path)}\n\n# Synthetic recorded instructions`,
        T0 + 1,
        { isMeta: true }
      )
    ])
    await writeCatalog({ cliSessionId: S1 })
    const source = createSource()
    expect(JSON.stringify(await source.catalog())).not.toContain('recorded instructions')
    const key = { tool: 'claude' as const, id: S1 }
    const detail = await source.recentMessages(key, 20)
    expect(detail).toMatchObject({
      kind: 'messages',
      messages: [{ skill: { name: 'synthetic-skill', path } }]
    })
    expect(JSON.stringify(detail)).not.toContain('recorded instructions')
    const request = { at: T0, name: 'synthetic-skill', path }
    expect(await source.getSkill!(key, request)).toMatchObject({
      source: 'conversation',
      text: '# Synthetic recorded instructions'
    })
    await writeFile(transcript, promptLine('Replacement synthetic prompt', T0))
    expect(await source.getSkill!(key, request)).toEqual({
      kind: 'unavailable',
      reason: 'not-found'
    })
    expect(await source.getSkill!({ ...key, id: S2 }, request)).toEqual({
      kind: 'unavailable',
      reason: 'not-found'
    })
    expect(opened.every((file) => !file.endsWith('SKILL.md'))).toBe(true)
  })
})

describe('the observed format (fixture claude-2.1.295)', () => {
  const desktop = '00000000-0000-4000-8000-0000000000c1'
  const report = '00000000-0000-4000-8000-0000000000c2'
  const second = (n: number) => T0 + n * SECOND

  beforeEach(async () => {
    await rm(join(home, '.claude'), { recursive: true })
    await rm(paths.catalog, { recursive: true })
    await cp(join(FIXTURE, 'claude'), join(home, '.claude'), { recursive: true })
    await cp(join(FIXTURE, 'claude-code-sessions'), paths.catalog, { recursive: true })
    for (const file of await readdir(home, { recursive: true, withFileTypes: true })) {
      if (file.isFile()) await setModified(join(file.parentPath, file.name), NOW - 10 * MINUTE)
    }
  })

  it('lists the sessions, newest first, without the archived one or the helper process', async () => {
    const source = createSource()
    expect(await source.catalog()).toEqual([
      {
        key: { tool: 'claude', id: report },
        summary: {
          title: 'Synthetic report session',
          workspacePath: CWD,
          lastActivityAt: second(370),
          toolVersion: VERSION
        },
        turn: { kind: 'claude', registry: null },
        lastReply: {
          cursor: '00000000-0000-4000-8000-000000000e1c',
          completedAt: second(365),
          isError: true,
          errorCode: 'rate_limit',
          newerTurnStarted: false
        }
      },
      {
        key: { tool: 'claude', id: desktop },
        summary: {
          title: 'Synthetic Desktop session',
          workspacePath: CWD,
          lastActivityAt: second(64),
          toolVersion: VERSION
        },
        turn: {
          kind: 'claude',
          registry: { status: 'waiting', waitingFor: 'permission prompt', ownerAlive: true }
        },
        lastReply: {
          cursor: '00000000-0000-4000-8000-000000000e07',
          completedAt: second(9),
          isError: false,
          errorCode: null,
          newerTurnStarted: true
        }
      }
    ])
    expect(source.health()).toEqual({ state: 'connected', lastReadAt: NOW })
    expect(alive).toHaveBeenCalledExactlyOnceWith(48151, 'Thu Jan 15 09:00:00 2026')
    expect(source.watchedFiles()).toEqual([])
  })

  it('reads the prompts and replies, without what the user did not type', async () => {
    const source = createSource()
    await source.catalog()
    expect(await source.recentMessages({ tool: 'claude', id: desktop }, 20)).toEqual({
      kind: 'messages',
      hasOlder: false,
      messages: [
        {
          kind: 'prompt',
          text: 'Synthetic prompt: list the files in this folder.',
          at: second(2)
        },
        { kind: 'reply', text: 'Synthetic note: I will look at the folder.', at: second(4) },
        {
          kind: 'tool-calls',
          count: 2,
          names: ['Bash', 'Read'],
          at: second(5),
          calls: [
            emptyCall('Bash', second(5), { status: 'done' }),
            emptyCall('Read', second(7), { status: 'done' })
          ]
        },
        { kind: 'reply', text: 'Synthetic answer: the folder holds two files.', at: second(9) },
        { kind: 'prompt', text: 'Synthetic prompt: fetch the synthetic page.', at: second(62) },
        {
          kind: 'tool-calls',
          count: 1,
          names: ['WebFetch'],
          at: second(64),
          // The session waits on a permission prompt for this call.
          calls: [emptyCall('WebFetch', second(64), { status: 'pending' })]
        }
      ]
    })
    expect(await source.recentMessages({ tool: 'claude', id: report }, 20)).toEqual({
      kind: 'messages',
      hasOlder: false,
      messages: [
        { kind: 'prompt', text: 'Synthetic prompt: summarize the notes.', at: second(120) },
        { kind: 'reply', text: 'Synthetic summary.', at: second(125) },
        { kind: 'prompt', text: 'Synthetic prompt: write a long report.', at: second(180) },
        {
          kind: 'tool-calls',
          count: 1,
          names: ['Write'],
          at: second(182),
          calls: [
            emptyCall('Write', second(182), { status: 'failed', error: 'User rejected tool use' })
          ]
        },
        { kind: 'prompt', text: 'Synthetic prompt: try a shorter report.', at: second(240) },
        { kind: 'reply', text: 'Synthetic note about the finished task.', at: second(305) },
        { kind: 'prompt', text: 'Synthetic prompt: one more question.', at: second(360) }
      ]
    })
  })

  it('holds no real IDs or paths', async () => {
    const files = (await readdir(FIXTURE, { recursive: true, withFileTypes: true })).filter(
      (file) => file.isFile()
    )
    expect(files.length).toBeGreaterThan(5)
    for (const file of files) {
      const text = await readFile(join(file.parentPath, file.name), 'utf8')
      for (const [id] of `${file.name}\n${text}`.matchAll(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g
      )) {
        expect(id.startsWith('00000000-0000-4000-8000-')).toBe(true)
      }
      for (const [path] of text.matchAll(/\/Users\/[^/"\s]+/g)) {
        expect(path).toBe('/Users/synthetic')
      }
    }
  })
})

describe('catalog', () => {
  it('lists a catalog entry as idle when its process is not running', async () => {
    await writeCatalog({ cliSessionId: S1, title: 'Synthetic session' })
    await writeTranscript(S1, finishedSession(R1))
    const [facts] = await createSource().catalog()
    expect(facts).toMatchObject({
      key: { tool: 'claude', id: S1 },
      summary: { title: 'Synthetic session', workspacePath: CWD },
      turn: { kind: 'claude', registry: null },
      lastReply: { cursor: R1, isError: false, newerTurnStarted: false }
    })
    expect(alive).not.toHaveBeenCalled()
  })

  it('joins the catalog and the registry by CLI session ID, not by the file name', async () => {
    const file = await writeCatalog({ cliSessionId: S1, title: 'Catalog title' })
    expect(file).not.toContain(S1)
    await writeRegistry({ pid: 4242, sessionId: S1, status: 'busy', name: 'Registry name' })
    await writeTranscript(S1, finishedSession(R1))
    const facts = await createSource().catalog()
    expect(facts).toHaveLength(1)
    expect(facts[0]).toMatchObject({
      summary: { title: 'Catalog title' },
      turn: { kind: 'claude', registry: { status: 'busy', waitingFor: null, ownerAlive: true } }
    })
  })

  it('reports each registry status', async () => {
    await writeTranscript(S1, finishedSession(R1))
    const source = createSource()
    const cases = [
      [{ status: 'busy' }, { status: 'busy', waitingFor: null }],
      [
        { status: 'waiting', waitingFor: 'permission prompt' },
        { status: 'waiting', waitingFor: 'permission prompt' }
      ],
      [
        { status: 'waiting', waitingFor: 'input needed' },
        { status: 'waiting', waitingFor: 'input needed' }
      ],
      [{ status: 'idle' }, { status: 'idle', waitingFor: null }],
      [{ status: null }, { status: null, waitingFor: null }]
    ] as const
    for (const [written, reported] of cases) {
      await writeRegistry({ pid: 4242, sessionId: S1, ...written })
      clock += MINUTE
      const [facts] = await source.catalog()
      expect(facts?.turn).toEqual({
        kind: 'claude',
        registry: { ...reported, ownerAlive: true }
      })
    }
  })

  it('reports a registry status it does not know as an unsupported format', async () => {
    await writeRegistry({ pid: 4242, sessionId: S1, status: 'compacting' })
    await writeTranscript(S1, finishedSession(R1))
    const [facts] = await createSource().catalog()
    expect(facts?.turn).toEqual({ kind: 'unsupported' })
  })

  it('reports whether the registry process still runs, with its start time', async () => {
    await writeRegistry({ pid: 4242, sessionId: S1, status: 'busy', procStart: 'Synthetic start' })
    await writeTranscript(S1, finishedSession(R1))
    alive.mockResolvedValue(false)
    const [facts] = await createSource().catalog()
    expect(facts?.turn).toMatchObject({ registry: { status: 'busy', ownerAlive: false } })
    expect(alive).toHaveBeenCalledWith(4242, 'Synthetic start')
  })

  it('checks liveness only while the registry says busy or waiting', async () => {
    await writeRegistry({ pid: 4242, sessionId: S1, status: 'idle' })
    await writeTranscript(S1, finishedSession(R1))
    await writeRegistry({ pid: 4243, sessionId: S2, status: 'waiting', waitingFor: 'input needed' })
    await writeTranscript(S2, finishedSession(R2))
    await createSource().catalog()
    expect(alive).toHaveBeenCalledExactlyOnceWith(4243, 'Thu Jan 15 09:00:00 2026')
  })

  it('trusts the registry when the liveness check itself fails', async () => {
    await writeRegistry({ pid: 4242, sessionId: S1, status: 'busy' })
    await writeTranscript(S1, finishedSession(R1))
    alive.mockRejectedValue(new Error('synthetic failure'))
    const [facts] = await createSource().catalog()
    expect(facts?.turn).toMatchObject({ registry: { ownerAlive: true } })
  })

  it('lists a session only the registry names (a CLI session) once it has a transcript', async () => {
    await writeRegistry({ pid: 4242, sessionId: S1, status: 'idle', name: 'Synthetic CLI session' })
    const source = createSource()
    expect(await source.catalog()).toEqual([])
    await writeTranscript(S1, [...finishedSession(R1), customTitleLine('Custom title')])
    expect(await source.catalog()).toMatchObject([
      { key: { id: S1 }, summary: { title: 'Synthetic CLI session' } }
    ])
  })

  it('does not list a catalog entry without a transcript', async () => {
    await writeCatalog({ cliSessionId: S1 })
    expect(await createSource().catalog()).toEqual([])
  })

  it('finds a transcript whose folder name does not follow the working folder', async () => {
    await writeCatalog({ cliSessionId: S1 })
    await writeTranscript(S1, finishedSession(R1), NOW - MINUTE, '-Users-synthetic-shortened-1a2b')
    expect(ids(await createSource().catalog())).toEqual([S1])
  })

  it('does not list archived sessions, even while their registry entry exists', async () => {
    await writeCatalog({ cliSessionId: S1, isArchived: true })
    await writeRegistry({ pid: 4242, sessionId: S1, status: 'busy' })
    await writeTranscript(S1, finishedSession(R1))
    expect(await createSource().catalog()).toEqual([])
  })

  it('lists a session once when two catalog folders name it, using the newer entry', async () => {
    await writeCatalog(
      { cliSessionId: S1, title: 'Older entry', lastActivityAt: NOW - 30 * MINUTE },
      NOW - MINUTE,
      ['account-a', 'organization']
    )
    await writeCatalog(
      { cliSessionId: S1, title: 'Newer entry', lastActivityAt: NOW - 2 * MINUTE },
      NOW - MINUTE,
      ['account-b', 'organization']
    )
    await writeTranscript(S1, finishedSession(R1))
    const facts = await createSource().catalog()
    expect(facts.map((fact) => fact.summary.title)).toEqual(['Newer entry'])
  })

  it('uses the newer registry entry when two name one session', async () => {
    await writeRegistry({ pid: 4242, sessionId: S1, status: 'busy', updatedAt: T0 })
    await writeRegistry({ pid: 4243, sessionId: S1, status: 'idle', updatedAt: T0 + MINUTE })
    await writeTranscript(S1, finishedSession(R1))
    const facts = await createSource().catalog()
    expect(facts).toHaveLength(1)
    expect(facts[0]?.turn).toMatchObject({ registry: { status: 'idle' } })
    expect(alive).not.toHaveBeenCalled()
  })

  it('reports an API error, a stopped turn, and a denied permission', async () => {
    await writeCatalog({ cliSessionId: S1 })
    await writeTranscript(S1, [
      ...finishedSession(R1),
      promptLine('Synthetic retry.', T0 + MINUTE),
      apiErrorLine('server_error', T0 + 2 * MINUTE, R2)
    ])
    await writeCatalog({ cliSessionId: S2 })
    await writeTranscript(S2, [
      ...finishedSession(R1),
      promptLine('Synthetic long task.', T0 + MINUTE),
      interruptLine(STOP, T0 + 2 * MINUTE)
    ])
    await writeCatalog({ cliSessionId: S3 })
    await writeTranscript(S3, [
      promptLine('Synthetic fetch.', T0 + MINUTE),
      assistantLine([{ type: 'tool_use', name: 'WebFetch' }], T0 + 2 * MINUTE, {
        stopReason: 'tool_use'
      }),
      toolResultLine(T0 + 3 * MINUTE, true),
      interruptLine(DENIED, T0 + 3 * MINUTE)
    ])
    const facts = await createSource().catalog()
    expect(byId(facts, S1)?.lastReply).toMatchObject({
      cursor: R2,
      isError: true,
      errorCode: 'server_error',
      newerTurnStarted: false
    })
    expect(byId(facts, S2)?.lastReply).toMatchObject({ cursor: R1, newerTurnStarted: true })
    expect(byId(facts, S3)?.lastReply).toBeNull()
  })

  it('ignores unknown fields, unknown record types, and malformed lines', async () => {
    const catalog = JSON.parse(catalogJson({ cliSessionId: S1 })) as Record<string, unknown>
    const path = join(paths.catalog, 'account', 'organization', 'local_synthetic.json')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify({ ...catalog, futureField: { nested: true } }))
    await writeTranscript(S1, [
      '{"type":"future-record","sessionId":"x","timestamp":"2026-01-15T09:30:00.000Z"}',
      'not json',
      '{"broken":',
      ...finishedSession(R1)
    ])
    const [facts] = await createSource().catalog()
    expect(facts).toMatchObject({ lastReply: { cursor: R1 }, turn: { kind: 'claude' } })
  })

  it('reports a transcript whose records it does not recognize as unsupported', async () => {
    await writeCatalog({ cliSessionId: S1 })
    await writeTranscript(S1, ['["a list"]', '42', '{"noType":true}'])
    await writeCatalog({ cliSessionId: S2 })
    await writeTranscript(S2, finishedSession(R2))
    const source = createSource()
    const facts = await source.catalog()
    expect(byId(facts, S1)?.turn).toEqual({ kind: 'unsupported' })
    // The other session is still read, so the tool as a whole is connected.
    expect(source.health()).toEqual({ state: 'connected', lastReadAt: NOW })
  })

  it('reads further back for a turn that wrote more than the first tail step', async () => {
    await writeCatalog({ cliSessionId: S1 })
    const toolCalls: string[] = []
    for (let n = 0; n < 400; n++) {
      toolCalls.push(
        assistantLine([{ type: 'tool_use', name: 'Bash' }], T0 + MINUTE + n, {
          stopReason: 'tool_use'
        }),
        toolResultLine(T0 + MINUTE + n)
      )
    }
    const filler = JSON.stringify({ type: 'attachment', padding: 'x'.repeat(1000) })
    await writeTranscript(S1, [
      ...finishedSession(R1),
      promptLine('Synthetic long task.', T0 + MINUTE),
      ...toolCalls,
      ...Array<string>(200).fill(filler)
    ])
    const [facts] = await createSource().catalog()
    expect(facts?.lastReply).toMatchObject({ cursor: R1, newerTurnStarted: true })
  })

  it('lists the 50 newest sessions of the last 7 days, plus every busy or waiting one', async () => {
    for (let n = 0; n < 55; n++) {
      const id = syntheticId(0x200 + n)
      await writeCatalog({ cliSessionId: id, lastActivityAt: NOW - (n + 1) * MINUTE })
      await writeTranscript(id, finishedSession(R1), NOW - (n + 1) * MINUTE)
    }
    const old = syntheticId(0x300)
    await writeCatalog({ cliSessionId: old, lastActivityAt: NOW - 8 * DAY }, NOW - 8 * DAY)
    await writeTranscript(old, finishedSession(R1, NOW - 8 * DAY), NOW - 8 * DAY)
    const oldWaiting = syntheticId(0x301)
    await writeRegistry({ pid: 4242, sessionId: oldWaiting, status: 'waiting' })
    await writeTranscript(oldWaiting, finishedSession(R1, NOW - 9 * DAY), NOW - 9 * DAY)
    const oldIdle = syntheticId(0x302)
    await writeRegistry({ pid: 4243, sessionId: oldIdle, status: 'idle' })
    await writeTranscript(oldIdle, finishedSession(R1, NOW - 9 * DAY), NOW - 9 * DAY)
    opened = []
    const facts = await createSource().catalog()
    expect(facts).toHaveLength(51)
    expect(ids(facts).slice(0, 50)).toEqual(
      Array.from({ length: 50 }, (_, n) => syntheticId(0x200 + n))
    )
    expect(ids(facts)[50]).toBe(oldWaiting)
    // Sessions past the cap and outside the window have their transcripts left unread.
    expect(opened).not.toContain(join(paths.projects, CWD_FOLDER, `${syntheticId(0x232)}.jsonl`))
    expect(opened).not.toContain(join(paths.projects, CWD_FOLDER, `${old}.jsonl`))
    expect(opened).not.toContain(join(paths.projects, CWD_FOLDER, `${oldIdle}.jsonl`))
  })

  it('gives no place to sessions whose transcripts changed without a timed record', async () => {
    // Records without a time (such as a custom title) changed these transcripts a minute ago, but
    // the sessions were last active 8 days ago.
    for (let n = 0; n < 100; n++) {
      const id = syntheticId(0x400 + n)
      // Half are Claude.app sessions, half CLI sessions: either alone would fill the cap.
      if (n < 50) await writeCatalog({ cliSessionId: id, lastActivityAt: NOW - 8 * DAY })
      else await writeRegistry({ pid: 5000 + n, sessionId: id, status: 'idle' })
      await writeTranscript(
        id,
        [...finishedSession(R1, NOW - 8 * DAY), customTitleLine('Synthetic title', id)],
        NOW - MINUTE
      )
    }
    // Claude.app saw activity 2 minutes ago, after the transcript's last timed record.
    await writeCatalog({ cliSessionId: S1, lastActivityAt: NOW - 2 * MINUTE })
    await writeTranscript(S1, finishedSession(R1, NOW - 8 * DAY), NOW - 2 * MINUTE)
    const facts = await createSource().catalog()
    expect(ids(facts)).toEqual([S1])
    expect(facts[0]?.summary.lastActivityAt).toBe(NOW - 2 * MINUTE)
  })

  it('does not read the transcript of an idle session last active more than 7 days ago', async () => {
    await writeRegistry({ pid: 4242, sessionId: S1, status: 'idle' })
    const path = await writeTranscript(S1, finishedSession(R1, NOW - 9 * DAY), NOW - 9 * DAY)
    expect(await createSource().catalog()).toEqual([])
    expect(opened).not.toContain(path)
  })

  it('never reads catalog files older than the 7-day window', async () => {
    const old = await writeCatalog({ cliSessionId: S1 }, NOW - 8 * DAY)
    await writeTranscript(S1, finishedSession(R1))
    expect(await createSource().catalog()).toEqual([])
    expect(opened).not.toContain(old)
  })

  it('drops a session once its last activity is more than 7 days old', async () => {
    await writeCatalog({ cliSessionId: S1, lastActivityAt: T0 })
    await writeTranscript(S1, finishedSession(R1))
    const source = createSource()
    expect(ids(await source.catalog())).toEqual([S1])
    clock = T0 + 8 * DAY
    expect(await source.refresh([])).toEqual([])
  })

  it('reads only what changed at the next reconcile', async () => {
    const catalogPath = await writeCatalog({ cliSessionId: S1 })
    const registryPath = await writeRegistry({ pid: 4242, sessionId: S1, status: 'idle' })
    const transcript = await writeTranscript(S1, finishedSession(R1))
    const source = createSource()
    await source.catalog()
    expect(new Set(opened)).toEqual(new Set([catalogPath, registryPath, transcript]))
    opened = []
    await source.catalog()
    expect(opened).toEqual([transcript])
  })

  it('never opens key files or anything outside the allowlisted files', async () => {
    const catalogPath = await writeCatalog({ cliSessionId: S1 })
    const registryPath = await writeRegistry({ pid: 4242, sessionId: S1, status: 'busy' })
    const transcript = await writeTranscript(S1, finishedSession(R1))
    const key = join(paths.registry, '4242.0123456789abcdef.key')
    await writeFile(key, 'synthetic key')
    const claude = join(home, '.claude')
    await writeFile(join(claude, 'history.jsonl'), '{}\n')
    await writeFile(join(claude, '.credentials.json'), '{}\n')
    const subagent = join(paths.projects, CWD_FOLDER, S1, 'subagents', 'agent-1.jsonl')
    await mkdir(dirname(subagent), { recursive: true })
    await writeFile(subagent, `${promptLine('Synthetic.', T0)}\n`)
    await writeFile(join(dirname(catalogPath), 'scheduled-tasks.json'), '{}')
    const source = createSource()
    await source.catalog()
    await source.refresh([key, join(claude, 'history.jsonl'), subagent])
    await source.recentMessages({ tool: 'claude', id: S1 }, 20)
    expect(new Set(opened)).toEqual(new Set([catalogPath, registryPath, transcript]))
  })

  it('writes nothing to the console', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((name) =>
      vi.spyOn(console, name).mockImplementation(() => undefined)
    )
    await writeCatalog({ cliSessionId: S1 })
    await writeTranscript(S1, [...finishedSession(R1), 'not json'])
    await writeFile(join(paths.registry, '4242.json'), '{"pid":4242,"sess')
    const source = createSource()
    await source.catalog()
    await source.recentMessages({ tool: 'claude', id: S1 }, 20)
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
    for (const spy of spies) spy.mockRestore()
  })
})

describe('health', () => {
  it('is Checking before the first reconcile', () => {
    expect(createSource().health()).toEqual({ state: 'checking' })
  })

  it('is Not installed when none of the folders exist', async () => {
    await rm(join(home, '.claude'), { recursive: true })
    await rm(join(home, 'Library'), { recursive: true })
    const source = createSource()
    expect(await source.catalog()).toEqual([])
    expect(source.health()).toEqual({ state: 'not-installed' })
  })

  it('is Connected when only some folders exist, such as without Claude.app', async () => {
    await rm(join(home, 'Library'), { recursive: true })
    await writeRegistry({ pid: 4242, sessionId: S1, status: 'busy' })
    await writeTranscript(S1, finishedSession(R1))
    const source = createSource()
    expect(ids(await source.catalog())).toEqual([S1])
    expect(source.health()).toEqual({ state: 'connected', lastReadAt: NOW })
  })

  it('reports sessions as Idle without a registry folder, as no process runs', async () => {
    await rm(paths.registry, { recursive: true })
    await writeCatalog({ cliSessionId: S1 })
    await writeTranscript(S1, finishedSession(R1))
    const source = createSource()
    expect((await source.catalog())[0]?.turn).toEqual({ kind: 'claude', registry: null })
    expect(source.health()).toEqual({ state: 'connected', lastReadAt: NOW })
  })

  it('is No access when a folder cannot be listed, with the last read time', async () => {
    await writeCatalog({ cliSessionId: S1 })
    await writeTranscript(S1, finishedSession(R1))
    const source = createSource()
    await source.catalog()
    await chmod(paths.catalog, 0o000)
    clock = NOW + MINUTE
    expect(await source.catalog()).toEqual([])
    expect(source.health()).toEqual({ state: 'no-access', lastReadAt: NOW })
  })

  it('reports no activity, not Idle, while the registry folder cannot be listed', async () => {
    await writeCatalog({ cliSessionId: S1 })
    await writeTranscript(S1, finishedSession(R1))
    await writeRegistry({ pid: 4242, sessionId: S1, status: 'busy' })
    const source = createSource()
    expect((await source.catalog())[0]?.turn).toMatchObject({ registry: { status: 'busy' } })
    await chmod(paths.registry, 0o000)
    clock = NOW + MINUTE
    const facts = await source.catalog()
    expect(ids(facts)).toEqual([S1])
    expect(facts[0]?.turn).toEqual({ kind: 'unreadable' })
    expect(source.health()).toEqual({ state: 'no-access', lastReadAt: NOW })
    await chmod(paths.registry, 0o755)
    clock = NOW + 2 * MINUTE
    expect((await source.catalog())[0]?.turn).toMatchObject({ registry: { status: 'busy' } })
    expect(source.health()).toEqual({ state: 'connected', lastReadAt: NOW + 2 * MINUTE })
  })

  it('is Unsupported, with the version, when no file is in a format it knows', async () => {
    await writeFile(
      join(paths.registry, '4242.json'),
      JSON.stringify({ processId: 4242, version: '9.0.0' })
    )
    const path = join(paths.catalog, 'account', 'organization', 'local_synthetic.json')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify({ id: 'synthetic' }))
    const source = createSource()
    expect(await source.catalog()).toEqual([])
    expect(source.health()).toEqual({ state: 'unsupported', toolVersion: '9.0.0' })
  })

  it('is Unsupported when only the registry format changed', async () => {
    await writeCatalog({ cliSessionId: S1 })
    await writeTranscript(S1, finishedSession(R1))
    const registry = JSON.parse(registryJson({ pid: 4242, sessionId: S1, status: 'busy' })) as {
      pid?: number
    }
    delete registry.pid
    await writeFile(
      join(paths.registry, '4242.json'),
      JSON.stringify({ ...registry, processId: 4242, version: '9.0.0' })
    )
    const source = createSource()
    // The catalog and the transcript still read, but the session's activity is not known.
    expect(ids(await source.catalog())).toEqual([S1])
    expect(source.health()).toEqual({ state: 'unsupported', toolVersion: '9.0.0' })
  })

  it('is Unsupported when only the catalog format changed', async () => {
    const catalog = JSON.parse(catalogJson({ cliSessionId: S1 })) as { cliSessionId?: string }
    delete catalog.cliSessionId
    const path = join(paths.catalog, 'account', 'organization', 'local_synthetic.json')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify({ ...catalog, cliSession: S1 }))
    await writeTranscript(S1, finishedSession(R1))
    await writeRegistry({ pid: 4242, sessionId: S2, status: 'busy' })
    await writeTranscript(S2, finishedSession(R2))
    const source = createSource()
    // The CLI session still reads, but the Claude.app session is missing from the list.
    expect(ids(await source.catalog())).toEqual([S2])
    expect(source.health()).toEqual({ state: 'unsupported', toolVersion: VERSION })
  })

  it('is Unsupported when only the transcript format changed', async () => {
    // A CLI session (registry only) and a Claude.app session.
    await writeRegistry({ pid: 4242, sessionId: S1, status: 'idle' })
    await writeTranscript(S1, ['{"kind":"future-record"}'])
    await writeCatalog({ cliSessionId: S2 })
    await writeTranscript(S2, ['["a list"]'])
    const source = createSource()
    expect((await source.catalog()).map((fact) => fact.turn)).toEqual([
      { kind: 'unsupported' },
      { kind: 'unsupported' }
    ])
    expect(source.health()).toEqual({ state: 'unsupported', toolVersion: VERSION })
  })

  it('is Connected when some files of each kind are in a format it knows', async () => {
    await writeFile(
      join(paths.registry, '4241.json'),
      JSON.stringify({ processId: 4241, version: '9.0.0' })
    )
    await writeRegistry({ pid: 4242, sessionId: S1, status: 'idle' })
    const path = join(paths.catalog, 'account', 'organization', 'local_synthetic.json')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify({ id: 'synthetic' }))
    await writeCatalog({ cliSessionId: S2 })
    await writeTranscript(S1, finishedSession(R1))
    await writeTranscript(S2, finishedSession(R2))
    const source = createSource()
    expect(ids(await source.catalog())).toEqual([S2, S1])
    expect(source.health()).toEqual({ state: 'connected', lastReadAt: NOW })
  })

  it('is Connected with the time of the last read', async () => {
    await writeCatalog({ cliSessionId: S1 })
    const path = await writeTranscript(S1, finishedSession(R1))
    const source = createSource()
    await source.catalog()
    clock = NOW + MINUTE
    await source.refresh([path])
    expect(source.health()).toEqual({ state: 'connected', lastReadAt: NOW + MINUTE })
  })
})

describe('refresh', () => {
  it('reads only the changed transcript', async () => {
    await writeCatalog({ cliSessionId: S1 })
    const changed = await writeTranscript(S1, [promptLine('Synthetic.', T0)])
    await writeCatalog({ cliSessionId: S2 })
    await writeTranscript(S2, finishedSession(R2))
    const source = createSource()
    await source.catalog()
    opened = []
    await append(changed, [
      assistantLine([{ type: 'text', text: 'Done.' }], T0 + MINUTE, { uuid: R1 })
    ])
    const facts = await source.refresh([changed])
    expect(opened).toEqual([changed])
    expect(byId(facts, S1)?.lastReply).toMatchObject({ cursor: R1, newerTurnStarted: false })
  })

  it('follows registry status changes, and treats a removed registry file as idle', async () => {
    await writeCatalog({ cliSessionId: S1 })
    await writeTranscript(S1, finishedSession(R1))
    const registry = await writeRegistry({ pid: 4242, sessionId: S1, status: 'idle' })
    const source = createSource()
    await source.catalog()

    await writeRegistry({ pid: 4242, sessionId: S1, status: 'busy', updatedAt: T0 + SECOND })
    expect((await source.refresh([registry]))[0]?.turn).toMatchObject({
      registry: { status: 'busy' }
    })
    await writeRegistry({
      pid: 4242,
      sessionId: S1,
      status: 'waiting',
      waitingFor: 'permission prompt',
      updatedAt: T0 + 2 * SECOND
    })
    expect((await source.refresh([registry]))[0]?.turn).toMatchObject({
      registry: { status: 'waiting', waitingFor: 'permission prompt' }
    })
    await rm(registry)
    expect((await source.refresh([registry]))[0]?.turn).toEqual({
      kind: 'claude',
      registry: null
    })
  })

  it('keeps what it read when a registry file is caught half-written', async () => {
    await writeTranscript(S1, finishedSession(R1))
    const registry = await writeRegistry({ pid: 4242, sessionId: S1, status: 'busy' })
    const source = createSource()
    await source.catalog()
    await writeFile(registry, '{"pid":4242,"sessionId":')
    expect((await source.refresh([registry]))[0]?.turn).toMatchObject({
      registry: { status: 'busy' }
    })
  })

  it('removes a CLI session when its process ends', async () => {
    const registry = await writeRegistry({ pid: 4242, sessionId: S1, status: 'idle' })
    await writeTranscript(S1, finishedSession(R1))
    const source = createSource()
    expect(ids(await source.catalog())).toEqual([S1])
    await rm(registry)
    expect(await source.refresh([registry])).toEqual([])
  })

  it('adds a new CLI session once its first prompt is written', async () => {
    const source = createSource()
    await source.catalog()
    const registry = await writeRegistry({ pid: 4242, sessionId: S1, status: null })
    expect(await source.refresh([registry])).toEqual([])
    const transcript = await writeTranscript(S1, [promptLine('Synthetic first prompt.', T0)])
    await writeRegistry({ pid: 4242, sessionId: S1, status: 'busy' })
    const facts = await source.refresh([transcript, registry])
    expect(ids(facts)).toEqual([S1])
    expect(facts[0]?.turn).toMatchObject({ registry: { status: 'busy' } })
  })

  it('ignores a helper process that never writes a transcript', async () => {
    const source = createSource()
    await source.catalog()
    const registry = await writeRegistry({ pid: 4242, sessionId: S1, status: 'idle' })
    expect(await source.refresh([registry])).toEqual([])
    await rm(registry)
    expect(await source.refresh([registry])).toEqual([])
  })

  it('updates the title and archive state from the catalog', async () => {
    const path = await writeCatalog({ cliSessionId: S1, title: 'First title' })
    await writeTranscript(S1, finishedSession(R1))
    const source = createSource()
    await source.catalog()
    // Claude.app writes a temporary file and renames it over the catalog file.
    const replace = async (options: Parameters<typeof catalogJson>[0]): Promise<void> => {
      await writeFile(`${path}.tmp`, catalogJson({ lastActivityAt: NOW - MINUTE, ...options }))
      await rename(`${path}.tmp`, path)
    }
    await replace({ cliSessionId: S1, title: 'Second title' })
    expect((await source.refresh([path]))[0]?.summary.title).toBe('Second title')
    await replace({ cliSessionId: S1, title: 'Second title', isArchived: true })
    expect(await source.refresh([path])).toEqual([])
  })

  it('keeps a catalog entry while its file is being replaced', async () => {
    const path = await writeCatalog({ cliSessionId: S1, title: 'Synthetic title' })
    await writeTranscript(S1, finishedSession(R1))
    const source = createSource()
    await source.catalog()
    await rename(path, `${path}.moved`)
    expect((await source.refresh([path]))[0]?.summary.title).toBe('Synthetic title')
  })

  it('re-checks liveness without reading any file when given no paths', async () => {
    await writeRegistry({ pid: 4242, sessionId: S1, status: 'busy' })
    await writeTranscript(S1, finishedSession(R1))
    const source = createSource()
    await source.catalog()
    opened = []
    alive.mockResolvedValue(false)
    clock = NOW + 2 * SECOND
    expect((await source.refresh([]))[0]?.turn).toMatchObject({ registry: { ownerAlive: true } })
    clock = NOW + 30 * SECOND
    expect((await source.refresh([]))[0]?.turn).toMatchObject({ registry: { ownerAlive: false } })
    expect(opened).toEqual([])
    expect(alive).toHaveBeenCalledTimes(2)
  })

  it('checks a reused process ID again when its start time changes', async () => {
    const registry = await writeRegistry({ pid: 4242, sessionId: S1, status: 'busy' })
    await writeTranscript(S1, finishedSession(R1))
    const source = createSource()
    await source.catalog()
    await writeRegistry({ pid: 4242, sessionId: S1, status: 'busy', procStart: 'Other start' })
    alive.mockResolvedValue(false)
    expect((await source.refresh([registry]))[0]?.turn).toMatchObject({
      registry: { ownerAlive: false }
    })
    expect(alive).toHaveBeenLastCalledWith(4242, 'Other start')
  })

  it('ignores a changed path with `.` or `..` parts', async () => {
    await writeCatalog({ cliSessionId: S1 })
    await writeTranscript(S1, finishedSession(R1))
    await writeCatalog({ cliSessionId: S2 })
    const source = createSource()
    await source.catalog()
    // A listed transcript named another way, and the transcript of a session not listed yet.
    const listed = [paths.projects, CWD_FOLDER, '..', CWD_FOLDER, `${S1}.jsonl`].join(sep)
    const added = await writeTranscript(S2, finishedSession(R2))
    const addedAnotherWay = [paths.projects, '.', CWD_FOLDER, `${S2}.jsonl`].join(sep)
    opened = []
    const facts = await source.refresh([listed, addedAnotherWay])
    expect(ids(facts)).toEqual([S1])
    expect(facts[0]?.turn).toEqual({ kind: 'claude', registry: null })
    expect(opened).toEqual([])
    // Named the usual way, the new transcript is read, and both sessions stay readable.
    expect(ids(await source.refresh([added]))).toEqual([S1, S2])
    expect((await source.catalog()).map((fact) => fact.turn.kind)).toEqual(['claude', 'claude'])
    expect(opened).not.toContain(listed)
  })

  it('drops a session whose transcript was removed', async () => {
    await writeCatalog({ cliSessionId: S1 })
    const path = await writeTranscript(S1, finishedSession(R1))
    const source = createSource()
    await source.catalog()
    await rm(path)
    expect(await source.refresh([path])).toEqual([])
  })

  it('reads the tail again when a transcript is replaced', async () => {
    await writeCatalog({ cliSessionId: S1 })
    const path = await writeTranscript(S1, [promptLine('Synthetic.', T0)])
    const source = createSource()
    await source.catalog()
    await writeFile(
      `${path}.tmp`,
      finishedSession(R1)
        .map((line) => `${line}\n`)
        .join('')
    )
    await rename(`${path}.tmp`, path)
    expect((await source.refresh([path]))[0]?.lastReply).toMatchObject({ cursor: R1 })
  })

  it('reports a transcript it cannot read as unreadable, and recovers', async () => {
    await writeCatalog({ cliSessionId: S1 })
    const path = await writeTranscript(S1, finishedSession(R1))
    const source = createSource()
    await source.catalog()
    await chmod(path, 0o000)
    expect((await source.refresh([path]))[0]?.turn).toEqual({ kind: 'unreadable' })
    await chmod(path, 0o644)
    expect((await source.refresh([path]))[0]?.turn).toMatchObject({ kind: 'claude' })
  })

  it('does not let a reconcile and a refresh overlap', async () => {
    await writeCatalog({ cliSessionId: S1 })
    const path = await writeTranscript(S1, [promptLine('Synthetic.', T0)])
    const source = createSource()
    await append(path, [
      assistantLine([{ type: 'text', text: 'Done.' }], T0 + MINUTE, { uuid: R1 })
    ])
    const [first, second] = await Promise.all([source.catalog(), source.refresh([path])])
    expect(first[0]?.lastReply).toMatchObject({ cursor: R1 })
    expect(second).toEqual(first)
  })
})

describe('recentMessages', () => {
  it('returns the last messages and says when older ones exist', async () => {
    await writeCatalog({ cliSessionId: S1 })
    await writeTranscript(S1, finishedSession(R1))
    const source = createSource()
    await source.catalog()
    expect(await source.recentMessages({ tool: 'claude', id: S1 }, 2)).toEqual({
      kind: 'messages',
      hasOlder: true,
      messages: [
        {
          kind: 'tool-calls',
          count: 1,
          names: ['Read'],
          at: T0 + 2 * SECOND,
          calls: [emptyCall('Read', T0 + 2 * SECOND, { status: 'done' })]
        },
        { kind: 'reply', text: 'Synthetic answer.', at: T0 + 4 * SECOND }
      ]
    })
    expect(await source.recentMessages({ tool: 'claude', id: S1 }, 0)).toEqual({
      kind: 'messages',
      hasOlder: true,
      messages: []
    })
  })

  it('reports a session it does not list as not found', async () => {
    await writeCatalog({ cliSessionId: S1 })
    await writeTranscript(S1, finishedSession(R1))
    const source = createSource()
    await source.catalog()
    expect(await source.recentMessages({ tool: 'claude', id: S2 }, 20)).toEqual({
      kind: 'not-found'
    })
    expect(await source.recentMessages({ tool: 'codex', id: S1 }, 20)).toEqual({
      kind: 'not-found'
    })
  })

  it('reports a transcript it cannot read', async () => {
    await writeCatalog({ cliSessionId: S1 })
    const path = await writeTranscript(S1, finishedSession(R1))
    const source = createSource()
    await source.catalog()
    await rm(path)
    expect(await source.recentMessages({ tool: 'claude', id: S1 }, 20)).toEqual({
      kind: 'unreadable'
    })
  })
})

describe('saved pins', () => {
  it('restores an old catalog pin and a finished CLI-only pin beyond normal age limits', async () => {
    const old = T0 - 100 * DAY
    await writeTranscript(S1, finishedSession(R1, old), old)
    await writeCatalog({ cliSessionId: S1, lastActivityAt: old }, old)
    await writeTranscript(S2, finishedSession(R2, old), old)
    let pins = [S1, S2]
    const source = createSource({ pinnedIds: () => pins })
    expect(ids(await source.catalog()).sort()).toEqual([S1, S2].sort())
    expect(await source.recentMessages({ tool: 'claude', id: S2 }, 20)).toMatchObject({
      kind: 'messages'
    })
    pins = []
    expect(await source.catalog()).toEqual([])
  })
})
