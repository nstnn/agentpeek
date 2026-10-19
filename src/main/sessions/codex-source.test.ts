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
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  agentMessageLine,
  childMetaLine,
  indexLine,
  MINUTE,
  rolloutLine,
  SECOND,
  sessionMetaLine,
  syntheticId,
  T0,
  taskCompleteLine,
  taskStartedLine,
  toolCallLine,
  turnAbortedLine,
  unknownLine,
  userMessageLine
} from '../../core/codex/test-records'
import type { SessionFacts } from '../../core/session'
import { type AccessGate, createAccessGate } from './access'
import { codexPaths } from './codex-files'
import { createCodexSource, type CodexSourceOptions } from './codex-source'
import type { SessionSource } from './session-source'

// Synthetic files only, in a temporary folder that stands in for the home folder. The clock is
// fixed one hour after the synthetic records start.
const NOW = T0 + 60 * MINUTE
const DAY = 24 * 60 * MINUTE
const FIXTURE = join(import.meta.dirname, 'fixtures', 'codex-0.162')

let root: string
let home: string
let paths: ReturnType<typeof codexPaths>
let opened: string[]
let gate: AccessGate
let clock: number
let appRunning: ReturnType<typeof vi.fn<() => Promise<boolean>>>

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agentpeek-codex-source-'))
  home = join(root, 'home')
  paths = codexPaths(home)
  await mkdir(paths.sessions, { recursive: true })
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
  appRunning = vi.fn(() => Promise.resolve(true))
})

afterEach(async () => {
  await chmod(paths.sessions, 0o755).catch(() => undefined)
  await rm(root, { recursive: true, force: true })
})

function createSource(options: Partial<CodexSourceOptions> = {}): SessionSource {
  return createCodexSource({ home, gate, isAppRunning: appRunning, now: () => clock, ...options })
}

let fileCount = 0

/** Writes a rollout in today's synthetic day folder. Its file time defaults to a minute ago. */
async function writeRollout(
  id: string,
  lines: readonly string[],
  modifiedAt = NOW - MINUTE
): Promise<string> {
  fileCount++
  const name = `rollout-2026-01-15T09-00-${String(fileCount % 60).padStart(2, '0')}-${id}.jsonl`
  const path = join(paths.sessions, '2026', '01', '15', name)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, lines.map((line) => `${line}\n`).join(''))
  await setModified(path, modifiedAt)
  return path
}

async function append(path: string, lines: readonly string[], modifiedAt = clock): Promise<void> {
  await appendFile(path, lines.map((line) => `${line}\n`).join(''))
  await setModified(path, modifiedAt)
}

async function setModified(path: string, modifiedAt: number): Promise<void> {
  await utimes(path, modifiedAt / 1000, modifiedAt / 1000)
}

async function writeIndex(lines: readonly string[]): Promise<void> {
  await writeFile(paths.index, lines.map((line) => `${line}\n`).join(''))
}

/** A user thread whose single turn ended with a final reply. */
function finishedThread(id: string, start = T0): string[] {
  return [
    sessionMetaLine({ id, at: start }),
    taskStartedLine(syntheticId(0x100), start + SECOND),
    userMessageLine('Synthetic prompt.', start + 2 * SECOND),
    agentMessageLine('Synthetic answer.', start + 3 * SECOND),
    taskCompleteLine(syntheticId(0x100), start + 4 * SECOND)
  ]
}

function ids(facts: readonly SessionFacts[]): string[] {
  return facts.map((fact) => fact.key.id)
}

const USER = syntheticId(1)
const CHILD = syntheticId(2)
const TURN_A = syntheticId(0xa)
const TURN_B = syntheticId(0xb)

describe('the observed format (fixture codex-0.162)', () => {
  const user = '00000000-0000-4000-8000-0000000000a1'
  const turnC = '00000000-0000-4000-8000-0000000000b3'

  beforeEach(async () => {
    await cp(FIXTURE, join(home, '.codex'), { recursive: true })
    await rm(join(home, '.codex', 'README.md'))
    for (const name of await readdir(join(paths.sessions, '2026', '01', '15'))) {
      await setModified(join(paths.sessions, '2026', '01', '15', name), NOW - 10 * MINUTE)
    }
  })

  it('lists only the user thread, with its renamed title and its error', async () => {
    const source = createSource()
    expect(await source.catalog()).toEqual([
      {
        key: { tool: 'codex', id: user },
        summary: {
          title: 'Synthetic thread, renamed',
          workspacePath: '/Users/synthetic/projects/demo',
          lastActivityAt: T0 + 125 * SECOND,
          toolVersion: '0.162.0-alpha.17.2'
        },
        turn: { kind: 'codex', lastTurnEvent: 'ended', appRunning: true },
        lastReply: {
          cursor: turnC,
          completedAt: T0 + 125 * SECOND,
          isError: true,
          errorCode: 'server_overloaded',
          newerTurnStarted: false
        }
      }
    ])
    expect(source.health()).toEqual({ state: 'connected', lastReadAt: NOW })
    // No turn is open, so the Codex app is not checked.
    expect(appRunning).not.toHaveBeenCalled()
  })

  it('reads the prompts and replies the Codex app shows, without the context Codex adds', async () => {
    const source = createSource()
    await source.catalog()
    expect(await source.recentMessages({ tool: 'codex', id: user }, 20)).toEqual({
      kind: 'messages',
      hasOlder: false,
      error: { cursor: syntheticId(0xb3), message: 'Synthetic error message.' },
      messages: [
        {
          kind: 'prompt',
          text: 'Synthetic prompt: list the files in this folder.',
          at: T0 + 3 * SECOND
        },
        { kind: 'reply', text: 'Synthetic note: I will look at the folder.', at: T0 + 5 * SECOND },
        { kind: 'tool-calls', count: 2, names: ['exec', 'js'], at: T0 + 6 * SECOND },
        {
          kind: 'reply',
          text: 'Synthetic answer: the folder holds two files.',
          at: T0 + 9 * SECOND
        },
        { kind: 'prompt', text: 'Synthetic prompt: wait for a minute.', at: T0 + 62 * SECOND },
        { kind: 'tool-calls', count: 1, names: ['exec'], at: T0 + 63 * SECOND },
        { kind: 'prompt', text: 'Synthetic prompt: try again.', at: T0 + 121 * SECOND }
      ]
    })
  })

  it('holds no real IDs or paths', async () => {
    const texts = await Promise.all(
      [
        'session_index.jsonl',
        ...(await readdir(join(FIXTURE, 'sessions', '2026', '01', '15'))).map((name) =>
          join('sessions', '2026', '01', '15', name)
        )
      ].map((name) => readFile(join(FIXTURE, name), 'utf8'))
    )
    for (const text of texts) {
      for (const [id] of text.matchAll(
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
  it('lists only parent user threads, even though the index lists child threads too', async () => {
    await writeRollout(USER, finishedThread(USER))
    await writeRollout(CHILD, [childMetaLine(CHILD, USER), taskStartedLine(TURN_A, T0)])
    const subagent = syntheticId(3)
    await writeRollout(subagent, [
      sessionMetaLine({ id: subagent, source: { subagent: 'x' }, threadSource: 'subagent' }),
      taskStartedLine(TURN_A, T0)
    ])
    const automation = syntheticId(4)
    await writeRollout(automation, [
      sessionMetaLine({ id: automation, threadSource: 'automation' })
    ])
    await writeIndex([
      indexLine(USER, 'Synthetic thread', T0),
      indexLine(CHILD, 'Synthetic review', T0),
      indexLine(subagent, 'Synthetic subagent', T0),
      indexLine(automation, 'Synthetic automation', T0)
    ])
    expect(ids(await createSource().catalog())).toEqual([USER])
  })

  it('takes the last index line for each thread, and no title without a line', async () => {
    const other = syntheticId(5)
    await writeRollout(USER, finishedThread(USER, T0 + MINUTE))
    await writeRollout(other, finishedThread(other))
    await writeIndex([
      indexLine(USER, 'First name', T0),
      '{"id": broken',
      indexLine(USER, 'Second name', T0 + MINUTE)
    ])
    const facts = await createSource().catalog()
    expect(facts.map((fact) => [fact.key.id, fact.summary.title])).toEqual([
      [USER, 'Second name'],
      [other, null]
    ])
  })

  it('does not list a thread that has an index line but no rollout', async () => {
    await writeIndex([indexLine(USER, 'Synthetic archived thread', T0)])
    expect(await createSource().catalog()).toEqual([])
  })

  it('lists threads without an index file', async () => {
    await writeRollout(USER, finishedThread(USER))
    const facts = await createSource().catalog()
    expect(facts.map((fact) => fact.summary.title)).toEqual([null])
  })

  it('reports a running turn and checks the Codex app', async () => {
    await writeRollout(USER, [sessionMetaLine({ id: USER }), taskStartedLine(TURN_A, T0)])
    appRunning.mockResolvedValue(false)
    const [facts] = await createSource().catalog()
    expect(facts?.turn).toEqual({ kind: 'codex', lastTurnEvent: 'started', appRunning: false })
    expect(appRunning).toHaveBeenCalledTimes(1)
  })

  it('treats a failed app check as running', async () => {
    await writeRollout(USER, [sessionMetaLine({ id: USER }), taskStartedLine(TURN_A, T0)])
    appRunning.mockRejectedValue(new Error('synthetic failure'))
    const [facts] = await createSource().catalog()
    expect(facts?.turn).toMatchObject({ appRunning: true })
  })

  it('reports a stopped turn as ended with no reply', async () => {
    await writeRollout(USER, [
      sessionMetaLine({ id: USER }),
      taskStartedLine(TURN_A, T0),
      turnAbortedLine(TURN_A, T0 + MINUTE)
    ])
    const [facts] = await createSource().catalog()
    expect(facts?.turn).toMatchObject({ lastTurnEvent: 'ended' })
    expect(facts?.lastReply).toBeNull()
  })

  it('skips malformed lines and unknown record types', async () => {
    await writeRollout(USER, [
      sessionMetaLine({ id: USER }),
      taskStartedLine(TURN_A, T0),
      '{"timestamp":"2026-01-15T09:00:01.000Z","type":"event_m',
      unknownLine('world_state', T0 + SECOND),
      unknownLine('token_usage_record', T0 + 2 * SECOND),
      'not json at all',
      taskCompleteLine(TURN_A, T0 + 3 * SECOND)
    ])
    const [facts] = await createSource().catalog()
    expect(facts?.turn).toMatchObject({ kind: 'codex', lastTurnEvent: 'ended' })
    expect(facts?.lastReply).toMatchObject({ cursor: TURN_A, isError: false })
    expect(facts?.summary.lastActivityAt).toBe(T0 + 3 * SECOND)
  })

  it('reports a rollout whose records it does not recognize as unsupported', async () => {
    await writeRollout(USER, [
      sessionMetaLine({ id: USER }),
      JSON.stringify({ kind: 'new_format', at: 1 }),
      JSON.stringify({ kind: 'new_format', at: 2 })
    ])
    const [facts] = await createSource().catalog()
    expect(facts?.turn).toEqual({ kind: 'unsupported' })
  })

  it('reports no turn event for a thread that has none yet', async () => {
    await writeRollout(USER, [sessionMetaLine({ id: USER }), unknownLine('world_state', T0)])
    const [facts] = await createSource().catalog()
    expect(facts?.turn).toEqual({ kind: 'codex', lastTurnEvent: null, appRunning: true })
  })

  it('reads further back for a turn that wrote more than the first tail step', async () => {
    const padding = 'x'.repeat(10_000)
    const filler = Array.from({ length: 40 }, (_, index) =>
      rolloutLine('response_item', { type: 'reasoning', padding }, T0 + index * SECOND)
    )
    await writeRollout(USER, [
      sessionMetaLine({ id: USER }),
      taskStartedLine(TURN_A, T0),
      ...filler
    ])
    const [facts] = await createSource().catalog()
    expect(facts?.turn).toMatchObject({ lastTurnEvent: 'started' })
  })

  it('does not list a thread whose first line is over the cap, and reports the format', async () => {
    const huge = sessionMetaLine({ id: USER }).replace(
      '"id"',
      `"padding":"${'x'.repeat(1 << 20)}","id"`
    )
    await writeRollout(USER, [huge, taskStartedLine(TURN_A, T0)])
    const source = createSource()
    expect(await source.catalog()).toEqual([])
    expect(source.health()).toEqual({ state: 'unsupported', toolVersion: null })
  })

  it('reports an unsupported format with its version when no first line is recognized', async () => {
    await writeRollout(USER, [rolloutLine('thread_header', {}, T0)])
    await writeRollout(
      CHILD,
      [rolloutLine('thread_header', { cli_version: '9.0.0' }, T0)],
      NOW - 2 * MINUTE
    )
    const source = createSource()
    expect(await source.catalog()).toEqual([])
    expect(source.health()).toEqual({ state: 'unsupported', toolVersion: '9.0.0' })
  })

  it('stays connected when some first lines are recognized', async () => {
    await writeRollout(USER, finishedThread(USER))
    await writeRollout(CHILD, [rolloutLine('thread_header', {}, T0)])
    const source = createSource()
    await source.catalog()
    expect(source.health()).toEqual({ state: 'connected', lastReadAt: NOW })
  })

  it('lists one rollout per thread, the newest', async () => {
    const older = await writeRollout(USER, finishedThread(USER, T0), NOW - 30 * MINUTE)
    const newer = await writeRollout(USER, finishedThread(USER, T0 + MINUTE))
    const source = createSource()
    expect(ids(await source.catalog())).toEqual([USER])
    expect(source.watchedFiles()).toEqual([newer])
    expect(source.watchedFiles()).not.toContain(older)
  })

  it('lists the 50 newest user threads from the last 7 days; child threads do not count', async () => {
    const users = Array.from({ length: 52 }, (_, index) => syntheticId(0x1000 + index))
    for (const [index, id] of users.entries()) {
      await writeRollout(id, finishedThread(id, T0 + index * SECOND), NOW - (60 - index) * MINUTE)
    }
    for (let index = 0; index < 5; index++) {
      const id = syntheticId(0x2000 + index)
      await writeRollout(id, [childMetaLine(id, USER)], NOW - index * SECOND)
    }
    const old = syntheticId(0x3000)
    await writeRollout(old, finishedThread(old, T0 - 8 * DAY), NOW - 8 * DAY)
    const listed = ids(await createSource().catalog())
    expect(listed).toEqual(users.slice(2).reverse())
    // Reading stops at 50 user threads: the two oldest and the 8-day-old one are never opened.
    for (const id of [users[0], users[1], old]) {
      expect(opened.some((path) => path.includes(id ?? ''))).toBe(false)
    }
  })

  it('drops a thread once its last activity is more than 7 days old', async () => {
    const path = await writeRollout(USER, finishedThread(USER, NOW - 2 * DAY), NOW - 2 * DAY)
    const source = createSource()
    expect(ids(await source.catalog())).toEqual([USER])
    clock = NOW + 5 * DAY + MINUTE
    expect(await source.refresh([])).toEqual([])
    expect(source.watchedFiles()).not.toContain(path)
  })

  it('finds an old thread the user resumed, at the next reconcile', async () => {
    const path = await writeRollout(USER, finishedThread(USER, T0 - 10 * DAY), NOW - 10 * DAY)
    const source = createSource()
    expect(await source.catalog()).toEqual([])
    expect(opened).not.toContain(path)

    await append(path, [taskStartedLine(TURN_B, NOW - SECOND)], NOW)
    const [facts] = await source.catalog()
    expect(facts?.key.id).toBe(USER)
    expect(facts?.turn).toMatchObject({ lastTurnEvent: 'started' })
    expect(facts?.lastReply).toMatchObject({ newerTurnStarted: true })
  })

  it('reads only what changed at the next reconcile, and never re-reads first lines', async () => {
    const userPath = await writeRollout(USER, finishedThread(USER))
    const childPath = await writeRollout(CHILD, [childMetaLine(CHILD, USER)])
    await writeIndex([indexLine(USER, 'Synthetic thread', T0)])
    const source = createSource()
    await source.catalog()
    opened = []
    await source.catalog()
    expect(opened.sort()).toEqual([paths.index, userPath].sort())
    expect(opened).not.toContain(childPath)
  })

  it('drops a thread whose rollout is gone', async () => {
    const path = await writeRollout(USER, finishedThread(USER))
    const source = createSource()
    expect(ids(await source.catalog())).toEqual([USER])
    await rm(path)
    expect(await source.catalog()).toEqual([])
    expect(source.watchedFiles()).toEqual([])
  })

  it('never opens a file outside the rollouts and the index', async () => {
    const rollout = await writeRollout(USER, finishedThread(USER))
    await writeIndex([indexLine(USER, 'Synthetic thread', T0)])
    const codex = join(home, '.codex')
    await writeFile(join(codex, 'auth.json'), '{"synthetic":true}\n')
    await writeFile(join(codex, '.codex-global-state.json'), '{}\n')
    await writeFile(join(codex, 'history.jsonl'), '{}\n')
    await writeFile(`${rollout}.zst`, 'synthetic')
    await setModified(`${rollout}.zst`, NOW)
    const source = createSource()
    await source.catalog()
    await source.refresh([join(codex, 'auth.json'), `${rollout}.zst`, join(codex, 'history.jsonl')])
    expect(new Set(opened)).toEqual(new Set([rollout, paths.index]))
  })

  it('writes nothing to the console', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((name) =>
      vi.spyOn(console, name).mockImplementation(() => undefined)
    )
    await writeRollout(USER, [...finishedThread(USER), 'not json'])
    await writeRollout(CHILD, [rolloutLine('thread_header', {}, T0)])
    const source = createSource()
    await source.catalog()
    await source.recentMessages({ tool: 'codex', id: USER }, 20)
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
    for (const spy of spies) spy.mockRestore()
  })
})

describe('health', () => {
  it('is Checking before the first reconcile', () => {
    expect(createSource().health()).toEqual({ state: 'checking' })
  })

  it('is Not installed without ~/.codex/sessions', async () => {
    await rm(join(home, '.codex'), { recursive: true })
    const source = createSource()
    expect(await source.catalog()).toEqual([])
    expect(source.health()).toEqual({ state: 'not-installed' })
  })

  it('is No access when the sessions folder cannot be listed, with the last read time', async () => {
    await writeRollout(USER, finishedThread(USER))
    const source = createSource()
    await source.catalog()
    await chmod(paths.sessions, 0o000)
    clock = NOW + MINUTE
    expect(await source.catalog()).toEqual([])
    expect(source.health()).toEqual({ state: 'no-access', lastReadAt: NOW })
    expect(source.watchedFiles()).toEqual([])
  })

  it('is Connected with the time of the last read', async () => {
    const path = await writeRollout(USER, finishedThread(USER))
    const source = createSource()
    await source.catalog()
    clock = NOW + MINUTE
    await source.refresh([path])
    expect(source.health()).toEqual({ state: 'connected', lastReadAt: NOW + MINUTE })
  })
})

describe('refresh', () => {
  it('reads only the changed rollout', async () => {
    const running = await writeRollout(USER, [
      sessionMetaLine({ id: USER }),
      taskStartedLine(TURN_A, T0)
    ])
    const other = syntheticId(6)
    await writeRollout(other, finishedThread(other))
    const source = createSource()
    await source.catalog()
    opened = []
    await append(running, [taskCompleteLine(TURN_A, T0 + MINUTE)])
    const facts = await source.refresh([running])
    expect(opened).toEqual([running])
    const fact = facts.find((candidate) => candidate.key.id === USER)
    expect(fact?.turn).toMatchObject({ lastTurnEvent: 'ended' })
    expect(fact?.lastReply).toMatchObject({ cursor: TURN_A, newerTurnStarted: false })
  })

  it('re-checks liveness without reading any file when given no paths', async () => {
    await writeRollout(USER, [sessionMetaLine({ id: USER }), taskStartedLine(TURN_A, T0)])
    const source = createSource()
    await source.catalog()
    opened = []
    appRunning.mockResolvedValue(false)
    clock = NOW + 2 * SECOND
    expect((await source.refresh([]))[0]?.turn).toMatchObject({ appRunning: true })
    clock = NOW + 30 * SECOND
    expect((await source.refresh([]))[0]?.turn).toMatchObject({ appRunning: false })
    expect(opened).toEqual([])
    expect(appRunning).toHaveBeenCalledTimes(2)
  })

  it('adds a new user thread and ignores a new child thread', async () => {
    const source = createSource()
    await source.catalog()
    const user = await writeRollout(USER, [
      sessionMetaLine({ id: USER }),
      taskStartedLine(TURN_A, T0)
    ])
    const child = await writeRollout(CHILD, [childMetaLine(CHILD, USER)])
    expect(ids(await source.refresh([user, child]))).toEqual([USER])
    expect(source.watchedFiles()).toEqual([user])
  })

  it('watches a new rollout until its first line arrives', async () => {
    const source = createSource()
    await source.catalog()
    const path = await writeRollout(USER, [])
    expect(await source.refresh([path])).toEqual([])
    expect(source.watchedFiles()).toEqual([path])

    await append(path, [sessionMetaLine({ id: USER }), taskStartedLine(TURN_A, T0)])
    expect(ids(await source.refresh([path]))).toEqual([USER])
    expect(source.watchedFiles()).toEqual([path])
  })

  it('finds a rollout without its first line at reconcile, and watches it', async () => {
    const path = await writeRollout(USER, [])
    const source = createSource()
    expect(await source.catalog()).toEqual([])
    expect(source.watchedFiles()).toEqual([path])
  })

  it('updates titles from the index', async () => {
    await writeRollout(USER, finishedThread(USER))
    await writeIndex([indexLine(USER, 'Synthetic thread', T0)])
    const source = createSource()
    await source.catalog()
    opened = []
    await appendFile(paths.index, `${indexLine(USER, 'Renamed thread', T0 + MINUTE)}\n`)
    const [facts] = await source.refresh([paths.index])
    expect(facts?.summary.title).toBe('Renamed thread')
    expect(opened).toEqual([paths.index])
  })

  it('drops a thread whose rollout was removed', async () => {
    const path = await writeRollout(USER, finishedThread(USER))
    const source = createSource()
    await source.catalog()
    await rm(path)
    expect(await source.refresh([path])).toEqual([])
    expect(source.watchedFiles()).toEqual([])
  })

  it('reads the tail again when a rollout is replaced', async () => {
    const path = await writeRollout(USER, [
      sessionMetaLine({ id: USER }),
      taskStartedLine(TURN_A, T0)
    ])
    const source = createSource()
    await source.catalog()
    const replacement = `${path}.tmp`
    await writeFile(replacement, [...finishedThread(USER)].map((line) => `${line}\n`).join(''))
    await rename(replacement, path)
    const [facts] = await source.refresh([path])
    expect(facts?.turn).toMatchObject({ lastTurnEvent: 'ended' })
  })

  it('reports a rollout it cannot read as unreadable, and recovers', async () => {
    const path = await writeRollout(USER, finishedThread(USER))
    const source = createSource()
    await source.catalog()
    await chmod(path, 0o000)
    expect((await source.refresh([path]))[0]?.turn).toEqual({ kind: 'unreadable' })
    await chmod(path, 0o644)
    expect((await source.refresh([path]))[0]?.turn).toMatchObject({ kind: 'codex' })
  })

  it('does not let a reconcile and a refresh overlap', async () => {
    const path = await writeRollout(USER, [
      sessionMetaLine({ id: USER }),
      taskStartedLine(TURN_A, T0)
    ])
    const source = createSource()
    await append(path, [taskCompleteLine(TURN_A, T0 + MINUTE)])
    const [first, second] = await Promise.all([source.catalog(), source.refresh([path])])
    expect(first[0]?.turn).toMatchObject({ lastTurnEvent: 'ended' })
    expect(second).toEqual(first)
  })
})

describe('recentMessages', () => {
  it('returns error text only on demand, never in facts, and drops it when a newer turn starts', async () => {
    const key = { tool: 'codex', id: USER } as const
    const path = await writeRollout(USER, [
      sessionMetaLine({ id: USER }),
      taskStartedLine(TURN_A, T0),
      taskCompleteLine(TURN_A, T0 + SECOND, {
        error: { codex_error_info: 'server_overloaded', message: 'Synthetic private error.' }
      })
    ])
    const source = createSource()
    expect(JSON.stringify(await source.catalog())).not.toContain('Synthetic private error.')
    expect(await source.recentMessages(key, 20)).toMatchObject({
      error: { cursor: TURN_A, message: 'Synthetic private error.' }
    })
    await append(path, [taskStartedLine('new-turn', T0 + 2 * SECOND)])
    expect(await source.recentMessages(key, 20)).not.toHaveProperty('error')
  })
  it('returns the last messages and says when older ones exist', async () => {
    await writeRollout(USER, [
      sessionMetaLine({ id: USER }),
      taskStartedLine(TURN_A, T0),
      userMessageLine('Synthetic prompt one.', T0 + SECOND),
      toolCallLine('exec', T0 + 2 * SECOND, 'custom_tool_call'),
      agentMessageLine('Synthetic answer one.', T0 + 3 * SECOND),
      taskCompleteLine(TURN_A, T0 + 4 * SECOND)
    ])
    const source = createSource()
    await source.catalog()
    expect(await source.recentMessages({ tool: 'codex', id: USER }, 2)).toEqual({
      kind: 'messages',
      hasOlder: true,
      messages: [
        { kind: 'tool-calls', count: 1, names: ['exec'], at: T0 + 2 * SECOND },
        { kind: 'reply', text: 'Synthetic answer one.', at: T0 + 3 * SECOND }
      ]
    })
    expect(await source.recentMessages({ tool: 'codex', id: USER }, 0)).toEqual({
      kind: 'messages',
      hasOlder: true,
      messages: []
    })
  })

  it('reports a session it does not list as not found', async () => {
    await writeRollout(USER, finishedThread(USER))
    const source = createSource()
    await source.catalog()
    expect(await source.recentMessages({ tool: 'codex', id: CHILD }, 20)).toEqual({
      kind: 'not-found'
    })
    expect(await source.recentMessages({ tool: 'claude', id: USER }, 20)).toEqual({
      kind: 'not-found'
    })
  })

  it('reports a rollout it cannot read', async () => {
    const path = await writeRollout(USER, finishedThread(USER))
    const source = createSource()
    await source.catalog()
    await rm(path)
    expect(await source.recentMessages({ tool: 'codex', id: USER }, 20)).toEqual({
      kind: 'unreadable'
    })
  })
})
