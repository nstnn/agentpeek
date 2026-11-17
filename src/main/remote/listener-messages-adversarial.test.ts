import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  decodeMessages,
  MAX_TIME,
  REMOTE_LIMITS,
  REMOTE_ROUTES,
  serializedTextBytes,
  type MessagesResponse,
  type StatusFrame
} from '../../core/remote/protocol'
import { cleanMessageText, projectRecentMessages } from '../../core/remote/recent-messages'
import type { RemoteSharing } from '../../core/remote/share-policy'
import type { RecentMessages, Session, SessionKey, SessionMessage } from '../../core/session'
import { createSnapshot, type SessionsSnapshot } from '../../core/snapshot'
import { testSession } from '../test-support'
import {
  exchange,
  freePort,
  HOST,
  OWNER,
  OWNER_HEADERS,
  rawHead,
  send,
  subscribe
} from './http-test-support'
import { startRemoteListener, type RemoteListener, type RemoteListenerOptions } from './listener'
import { createRemoteView, type RemoteView } from './remote-view'
import { createSessionIdMinter } from './session-ids'

// TASK-034: adversarial cases for protocol v2 recent messages on the Mac, written apart from the
// TASK-032 suite. Synthetic data only. Every message text carries SENTINEL so a leak is found by
// one search; no case here may see it outside a 200 answer for the session it asked for.

const SENTINEL = 'SENTINEL-M2-TEXT'
const SHARED = '/Users/synthetic/projects/shared-demo'
const SECRET = new Uint8Array(32).fill(3)
const mint = createSessionIdMinter(SECRET)

const A: SessionKey = { tool: 'codex', id: 'raw-adversarial-a' }
const B: SessionKey = { tool: 'claude', id: 'raw-adversarial-b' }

const textOf = (key: SessionKey) => `${SENTINEL} reply for ${key.id}`
const messagesOf = (key: SessionKey): RecentMessages => ({
  kind: 'messages',
  messages: [{ kind: 'reply', text: textOf(key), at: 7 }],
  hasOlder: false
})

function snapshot(takenAt = 1): SessionsSnapshot {
  const session = (key: SessionKey): Session =>
    testSession({
      key,
      summary: { title: 'title', workspacePath: SHARED, lastActivityAt: 5, toolVersion: '1' }
    })
  return createSnapshot({
    sessions: [session(A), session(B)],
    health: {
      codex: { state: 'connected', lastReadAt: 1 },
      claude: { state: 'connected', lastReadAt: 1 }
    },
    localState: { kind: 'available' },
    firstLaunch: false,
    fixture: true,
    takenAt
  })
}

type Reader = NonNullable<RemoteListenerOptions['readMessages']>

/** A reader that answers each key with its own text, held until the test releases it. */
function gatedReader() {
  const waiting: (() => void)[] = []
  const reader = vi.fn<Reader>(
    (key) => new Promise<RecentMessages>((done) => waiting.push(() => done(messagesOf(key))))
  )
  return {
    reader,
    started: () => reader.mock.calls.length,
    release: () => waiting.splice(0).forEach((finish) => finish())
  }
}

const answering = () => vi.fn<Reader>((key) => Promise.resolve(messagesOf(key)))

interface Policy {
  snapshot: SessionsSnapshot
  sharing: RemoteSharing
  generation: number
  details: boolean
}

const listeners: RemoteListener[] = []
const folders: string[] = []
const views: RemoteView[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(listeners.splice(0).map((listener) => listener.close('shutdown')))
  await Promise.all(views.splice(0).map((view) => view.close()))
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true })
})

async function start(reader: Reader, secret = SECRET) {
  const policy: Policy = {
    snapshot: snapshot(),
    sharing: { sharedWorkspaces: [SHARED], shareTitles: false },
    generation: 1,
    details: true
  }
  const result = await startRemoteListener({
    port: await freePort(),
    access: { ownerLogin: OWNER, hostName: HOST },
    secret,
    viewer: { page: null, assets: new Map() },
    snapshot: () => policy.snapshot,
    sharing: () => policy.sharing,
    generation: () => policy.generation,
    details: () => policy.details,
    readMessages: reader,
    now: () => 1_000
  })
  if (!result.ok) throw new Error(result.error)
  listeners.push(result.listener)
  const port = result.listener.port
  return {
    listener: result.listener,
    policy,
    port,
    get: (id: string, headers: Record<string, string> = { ...OWNER_HEADERS }) =>
      send(port, { path: REMOTE_ROUTES.messages(id), headers })
  }
}

const code = (body: string) => (JSON.parse(body) as { error?: string }).error

/** No refusal says anything but its code, and none carries message text. */
function inert(body: string): void {
  expect(body).not.toContain(SENTINEL)
  expect(body).not.toMatch(/raw-adversarial|\/Users\//)
}

describe('forged permission', () => {
  it('no header, method, body or target variant reads a session', async () => {
    const reader = answering()
    const h = await start(reader)
    const id = mint(A)
    const path = REMOTE_ROUTES.messages(id)
    const cases: {
      name: string
      path?: string
      method?: string
      headers?: Record<string, string>
    }[] = [
      {
        name: 'login in other case',
        headers: { Host: HOST, 'Tailscale-User-Login': OWNER.toUpperCase() }
      },
      {
        name: 'login list',
        headers: { Host: HOST, 'Tailscale-User-Login': `x@example.com,${OWNER}` }
      },
      { name: 'login empty', headers: { Host: HOST, 'Tailscale-User-Login': '' } },
      { name: 'name instead of login', headers: { Host: HOST, 'Tailscale-User-Name': OWNER } },
      { name: 'forwarded identity only', headers: { Host: HOST, 'X-Forwarded-User': OWNER } },
      {
        name: 'other Host',
        headers: { 'Tailscale-User-Login': OWNER, Host: 'other.example-tailnet.ts.net' }
      },
      { name: 'loopback Host', headers: { 'Tailscale-User-Login': OWNER, Host: '127.0.0.1' } },
      {
        name: 'cross-site Origin',
        headers: { ...OWNER_HEADERS, Origin: 'https://attacker.example' }
      },
      { name: 'null Origin', headers: { ...OWNER_HEADERS, Origin: 'null' } },
      { name: 'http Origin', headers: { ...OWNER_HEADERS, Origin: `http://${HOST}` } },
      { name: 'POST', method: 'POST' },
      { name: 'HEAD', method: 'HEAD' },
      { name: 'OPTIONS', method: 'OPTIONS' },
      { name: 'DELETE', method: 'DELETE' },
      { name: 'body', headers: { ...OWNER_HEADERS, 'Content-Length': '4' } },
      { name: 'trailing slash', path: `${path}/` },
      { name: 'query', path: `${path}?limit=1000` },
      { name: 'details query', path: `${path}?details=true` },
      { name: 'upper-case route', path: path.replace('messages', 'Messages') },
      { name: 'double slash', path: path.replace('/sessions', '//sessions') },
      { name: 'dot segment', path: `/v2/sessions/x/../${id}/messages` },
      { name: 'encoded id', path: path.replace(id[0]!, `%${id.charCodeAt(0).toString(16)}`) },
      { name: 'short id', path: REMOTE_ROUTES.messages(id.slice(1)) },
      { name: 'long id', path: REMOTE_ROUTES.messages(`${id}A`) },
      { name: 'v1', path: path.replace('/v2/', '/v1/') },
      { name: 'v3', path: path.replace('/v2/', '/v3/') },
      { name: 'raw key', path: REMOTE_ROUTES.messages(A.id) }
    ]
    for (const item of cases) {
      const reply = await send(h.port, {
        path: item.path ?? path,
        method: item.method ?? 'GET',
        headers: item.headers ?? { ...OWNER_HEADERS }
      })
      expect(reply.status, item.name).not.toBe(200)
      inert(reply.body)
    }
    expect(reader).not.toHaveBeenCalled()
  })

  it('raw requests a client library would not send read nothing either', async () => {
    const reader = answering()
    const h = await start(reader)
    const path = REMOTE_ROUTES.messages(mint(A))
    const heads = [
      // Two login headers, which Node joins with a comma.
      [
        `GET ${path} HTTP/1.1`,
        `Host: ${HOST}`,
        'Tailscale-User-Login: x@example.com',
        `Tailscale-User-Login: ${OWNER}`
      ],
      // Absolute form with the right name.
      [`GET https://${HOST}${path} HTTP/1.1`, `Host: ${HOST}`, `Tailscale-User-Login: ${OWNER}`],
      // A fragment, which browsers never send.
      [`GET ${path}#x HTTP/1.1`, `Host: ${HOST}`, `Tailscale-User-Login: ${OWNER}`],
      // A body announced by chunked encoding.
      [
        `GET ${path} HTTP/1.1`,
        `Host: ${HOST}`,
        `Tailscale-User-Login: ${OWNER}`,
        'Transfer-Encoding: chunked'
      ]
    ]
    for (const head of heads) {
      const { reply } = await exchange(h.port, rawHead([...head, 'Connection: close']))
      expect(reply, head[0]).not.toMatch(/^HTTP\/1\.1 200/)
      inert(reply)
    }
    expect(reader).not.toHaveBeenCalled()
  })

  it('the switch cannot be turned on from the network, only the status says it is on', async () => {
    const reader = answering()
    const h = await start(reader)
    h.policy.details = false
    for (const path of [
      `${REMOTE_ROUTES.messages(mint(A))}?details=1`,
      '/v2/details',
      '/v2/share-messages'
    ]) {
      for (const method of ['GET', 'POST', 'PUT']) {
        const reply = await send(h.port, { path, method })
        expect(reply.status).not.toBe(200)
        inert(reply.body)
      }
    }
    const reply = await h.get(mint(A))
    expect([reply.status, code(reply.body)]).toEqual([403, 'details-off'])
    expect(reader).not.toHaveBeenCalled()
  })
})

describe('swapped and replayed session IDs', () => {
  it('each ID reads only its own session, and the answer names that ID', async () => {
    const reader = answering()
    const h = await start(reader)
    for (const key of [A, B, A]) {
      const reply = await h.get(mint(key))
      const decoded = decodeMessages(reply.body)
      if (!decoded.ok) throw new Error(decoded.error)
      expect(decoded.response.session).toBe(mint(key))
      const other = key === A ? B : A
      expect(reply.body).toContain(textOf(key))
      expect(reply.body).not.toContain(textOf(other))
      expect(reader).toHaveBeenLastCalledWith(key, REMOTE_LIMITS.maxEntries)
    }
  })

  it('a raw ID under the other tool, a one-character change or another secret is not-found', async () => {
    const reader = answering()
    const h = await start(reader)
    const id = mint(A)
    const flipped = `${id.slice(0, -1)}${id.endsWith('A') ? 'B' : 'A'}`
    const variants = [
      mint({ tool: 'claude', id: A.id }),
      mint({ tool: 'codex', id: B.id }),
      flipped,
      createSessionIdMinter(new Uint8Array(32).fill(4))(A)
    ]
    const bodies = new Set<string>()
    for (const variant of variants) {
      const reply = await h.get(variant)
      expect(reply.status, variant).toBe(404)
      bodies.add(reply.body)
    }
    expect([...bodies]).toEqual(['{"v":2,"error":"not-found"}'])
    expect(reader).not.toHaveBeenCalled()
  })

  it('a replayed request after the switch, the share or the secret changed reads nothing', async () => {
    const reader = answering()
    const h = await start(reader)
    const id = mint(A)
    expect((await h.get(id)).status).toBe(200)
    expect(reader).toHaveBeenCalledOnce()

    h.policy.details = false
    h.policy.generation += 1
    expect(code((await h.get(id)).body)).toBe('details-off')

    h.policy.details = true
    h.policy.sharing = { sharedWorkspaces: [], shareTitles: false }
    h.policy.generation += 1
    expect(code((await h.get(id)).body)).toBe('not-found')
    expect(reader).toHaveBeenCalledOnce()

    // A new listener with another secret: the old ID means nothing there.
    const rotated = await start(reader, new Uint8Array(32).fill(9))
    expect(code((await rotated.get(id)).body)).toBe('not-found')
    expect(reader).toHaveBeenCalledOnce()
  })

  it('a replayed answer carries the generation it was checked under, so a newer status outranks it', async () => {
    const h = await start(answering())
    const first = decodeMessages((await h.get(mint(A))).body)
    h.policy.generation += 1
    const second = decodeMessages((await h.get(mint(A))).body)
    if (!first.ok || !second.ok) throw new Error('undecodable')
    expect(second.response.generation).toBe(first.response.generation + 1)
  })
})

describe('queued revoke', () => {
  it('pipelined reads on one connection get no text when the switch turns off mid-read', async () => {
    const gate = gatedReader()
    const h = await start(gate.reader)
    const line = (key: SessionKey, last = false) => [
      `GET ${REMOTE_ROUTES.messages(mint(key))} HTTP/1.1`,
      `Host: ${HOST}`,
      `Tailscale-User-Login: ${OWNER}`,
      ...(last ? ['Connection: close'] : [])
    ]
    const pending = exchange(
      h.port,
      [rawHead(line(A)), rawHead(line(B)), rawHead(line(A, true))].join('')
    )
    await expect.poll(gate.started).toBe(2)
    h.policy.details = false
    h.policy.generation += 1
    gate.release()
    const { reply } = await pending
    expect(reply).not.toContain(SENTINEL)
    // The first refusal closes the connection, so the later answers are never written at all.
    const statuses = [...reply.matchAll(/^HTTP\/1\.1 (\d{3})/gm)].map((match) => match[1])
    expect(statuses).toEqual(['403'])
    expect(reply).toContain('"error":"details-off"')
    expect(gate.started()).toBe(2)
  })

  it('off then on again during the read (same switch, new generation) still drops the text', async () => {
    const gate = gatedReader()
    const h = await start(gate.reader)
    const pending = h.get(mint(A))
    await expect.poll(gate.started).toBe(1)
    h.policy.details = false
    h.policy.generation += 1
    h.policy.details = true
    h.policy.generation += 1
    gate.release()
    const reply = await pending
    expect([reply.status, code(reply.body)]).toEqual([409, 'policy-changed'])
    inert(reply.body)
  })

  it('unshare then share again during the read drops the text', async () => {
    const gate = gatedReader()
    const h = await start(gate.reader)
    const pending = h.get(mint(A))
    await expect.poll(gate.started).toBe(1)
    h.policy.sharing = { sharedWorkspaces: [], shareTitles: false }
    h.policy.generation += 1
    h.policy.sharing = { sharedWorkspaces: [SHARED], shareTitles: false }
    h.policy.generation += 1
    gate.release()
    const reply = await pending
    expect([reply.status, code(reply.body)]).toEqual([409, 'policy-changed'])
    inert(reply.body)
  })

  it('the viewer leaving mid-read gets nothing written and frees the slot', async () => {
    const gate = gatedReader()
    const h = await start(gate.reader)
    const head = rawHead([
      `GET ${REMOTE_ROUTES.messages(mint(A))} HTTP/1.1`,
      `Host: ${HOST}`,
      `Tailscale-User-Login: ${OWNER}`
    ])
    const { connect } = await import('node:net')
    const socket = connect({ host: '127.0.0.1', port: h.port })
    let received = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => (received += chunk))
    socket.on('error', () => undefined)
    socket.write(head)
    await expect.poll(gate.started).toBe(1)
    socket.destroy()
    await new Promise((done) => setTimeout(done, 20))
    gate.release()
    await new Promise((done) => setTimeout(done, 20))
    expect(received).toBe('')
    // Both slots are free again.
    const first = h.get(mint(A))
    const second = h.get(mint(B))
    await expect.poll(gate.started).toBe(3)
    gate.release()
    expect((await first).status).toBe(200)
    expect((await second).status).toBe(200)
  })

  it('Remote View turned off with two reads in flight and a stream open delivers no text anywhere', async () => {
    const gate = gatedReader()
    const h = await start(gate.reader)
    const stream = subscribe(h.port)
    await expect.poll(() => stream.frames.length).toBe(1)
    const first = h.get(mint(A))
    const second = h.get(mint(B))
    await expect.poll(gate.started).toBe(2)
    await h.listener.close('remote-off')
    gate.release()
    for (const reply of [await first, await second]) {
      expect([reply.status, code(reply.body)]).toEqual([403, 'details-off'])
      inert(reply.body)
    }
    await stream.ended
    expect(stream.raw.join('')).not.toContain(SENTINEL)
    expect(stream.frames.at(-1)).toMatchObject({ type: 'end', reason: 'remote-off' })
  })
})

// A small deterministic generator, so a failure names the seed that found it.
function random(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0
    return state / 2 ** 32
  }
}

const PIECES = ['"', '\\', '😀', 'é', 'a', '\n', '\t', '\u0007', '‮', '\ud800', '<', ' ']

function hostileText(next: () => number, length: number): string {
  let text = SENTINEL
  while (text.length < length) text += PIECES[Math.floor(next() * PIECES.length)]
  return text
}

function hostileRead(seed: number): Extract<RecentMessages, { kind: 'messages' }> {
  const next = random(seed)
  const messages: SessionMessage[] = []
  const total = 1 + Math.floor(next() * 40)
  for (let index = 0; index < total; index += 1) {
    const roll = next()
    if (roll < 0.2) {
      const counts = [0, -1, 1.5, 3, 10_000, 10_001, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60]
      messages.push({
        kind: 'tool-calls',
        count: counts[Math.floor(next() * counts.length)]!,
        names: ['tool-name'],
        at: index
      })
    } else {
      const size = next() < 0.15 ? 70_000 + Math.floor(next() * 30_000) : Math.floor(next() * 6_000)
      messages.push({
        kind: roll < 0.6 ? 'prompt' : 'reply',
        text: hostileText(next, size),
        at: next() < 0.1 ? -5 : index
      })
    }
  }
  return { kind: 'messages', messages, hasOlder: next() < 0.2 }
}

describe('truncation is measurable', () => {
  it('300 hostile reads stay within every budget, with notices that match what was dropped', () => {
    let worstText = 0
    let worstResponse = 0
    let cuts = 0
    let olders = 0
    for (let seed = 1; seed <= 300; seed += 1) {
      const read = hostileRead(seed)
      const result = projectRecentMessages(read)
      if (result === 'not-found' || result.state !== 'messages') continue
      const { entries } = result
      expect(entries.length, `seed ${seed}`).toBeLessThanOrEqual(REMOTE_LIMITS.maxEntries)
      let text = 0
      for (const [index, entry] of entries.entries()) {
        if (entry.kind === 'tool-calls') {
          expect(
            Number.isSafeInteger(entry.count) && entry.count >= 1 && entry.count <= 10_000
          ).toBe(true)
          expect(Object.keys(entry).sort()).toEqual(['at', 'count', 'kind'])
          continue
        }
        expect(entry.text.length).toBeGreaterThan(0)
        // Cleaned: no controls but tab/newline, no bidi, no lone surrogates (round-trips as UTF-8).
        expect(entry.text).not.toMatch(/(?![\t\n])\p{Cc}|‮/u)
        expect(new TextDecoder().decode(new TextEncoder().encode(entry.text))).toBe(entry.text)
        text += serializedTextBytes(entry.text)
        if (entry.cut) {
          cuts += 1
          // Only the newest text is ever cut, so it is the last text entry.
          expect(entries.slice(index + 1).every((later) => later.kind === 'tool-calls')).toBe(true)
        }
      }
      expect(text, `seed ${seed}`).toBeLessThanOrEqual(REMOTE_LIMITS.maxMessageTextBytes)
      // `older` is exact: set if and only if the reader had more, or an entry was dropped.
      const projectable = read.messages.filter((message) =>
        message.kind === 'tool-calls'
          ? Math.min(Math.floor(message.count), REMOTE_LIMITS.maxToolCallCount) >= 1
          : cleanMessageText(message.text).length > 0
      ).length
      expect(result.older, `seed ${seed}`).toBe(read.hasOlder || entries.length < projectable)
      if (result.older) olders += 1
      const response: MessagesResponse = {
        v: 2,
        type: 'messages',
        session: mint(A),
        generation: Number.MAX_SAFE_INTEGER,
        sentAt: MAX_TIME,
        result
      }
      const serialized = JSON.stringify(response)
      expect(decodeMessages(serialized).ok, `seed ${seed}`).toBe(true)
      worstText = Math.max(worstText, text)
      worstResponse = Math.max(worstResponse, Buffer.byteLength(serialized))
    }
    expect(worstResponse).toBeLessThanOrEqual(REMOTE_LIMITS.maxDetailBytes)
    expect(cuts).toBeGreaterThan(0)
    expect(olders).toBeGreaterThan(0)
    expect(worstText).toBeLessThanOrEqual(REMOTE_LIMITS.maxMessageTextBytes)
    // Building the large texts one piece at a time dominates; under full-suite load it needs room.
  }, 30_000)

  it('a worst-case answer through the listener is under 72 KiB and decodes', async () => {
    const quotes = '"\\'.repeat(40_000)
    const reader = vi.fn<Reader>(() =>
      Promise.resolve({
        kind: 'messages',
        messages: Array.from({ length: 25 }, (_, index) => ({
          kind: index % 2 ? ('reply' as const) : ('prompt' as const),
          text: `${SENTINEL}${quotes}`,
          at: Number.MAX_SAFE_INTEGER
        })),
        hasOlder: false
      })
    )
    const h = await start(reader)
    const reply = await h.get(mint(A))
    expect(reply.status).toBe(200)
    expect(Buffer.byteLength(reply.body)).toBeLessThanOrEqual(REMOTE_LIMITS.maxDetailBytes)
    const decoded = decodeMessages(reply.body)
    if (!decoded.ok) throw new Error(decoded.error)
    expect(decoded.response.result).toMatchObject({ state: 'messages', older: true })
    if (decoded.response.result.state !== 'messages') throw new Error('not messages')
    expect(decoded.response.result.entries).toHaveLength(1)
    expect(decoded.response.result.entries[0]).toMatchObject({ cut: true })
  })

  it('a 4 MB reply is cut quickly, without blocking the listener for long', () => {
    const big = `${SENTINEL}${'😀"'.repeat(1_400_000)}`
    const started = performance.now()
    const result = projectRecentMessages({
      kind: 'messages',
      messages: [{ kind: 'reply', text: big, at: 1 }],
      hasOlder: false
    })
    const ms = performance.now() - started
    expect(result).toMatchObject({ state: 'messages', older: false })
    expect(ms).toBeLessThan(5_000)
  })
})

describe('skill-mention paths in hostile text', () => {
  // The contract: `[$name](<path>/SKILL.md)` becomes `$name`, and no skill-mention path leaves.
  const cases = [
    '[$demo](/Users/synthetic/.agents/skills/demo/SKILL.md)',
    '[$demo](</Users/synthetic/My Skills/demo/SKILL.md>)',
    '`[$demo](/Users/synthetic/.agents/skills/demo/SKILL.md)`',
    '> [$demo](/Users/synthetic/.agents/skills/demo/SKILL.md)',
    // F1: forms the first pattern missed.
    '[$demo](/Users/synthetic/My Skills/demo/SKILL.md)',
    '[$demo](/Users/synthetic/demo/skill.md)',
    '[$demo](/Users/synthetic/demo/SKILL.md "title")',
    '[$demo](/Users/synthetic/(x)/demo/SKILL.md)',
    '[$demo](/Users/synthetic/demo/SKILL.md#part)',
    '[$demo]( /Users/synthetic/demo/SKILL.md )',
    '[$demo] (/Users/synthetic/demo/SKILL.md)',
    '[$demo](file:///Users/synthetic/demo/SKILL.md)',
    '[$demo](/Users/synthetic/demo/SKILL.md',
    'see [$demo](/Users/synthetic/a/SKILL.md) and [$demo](/Users/synthetic/b/SKILL.md)'
  ]
  for (const text of cases) {
    it(`drops the path from ${text}`, () => {
      const result = projectRecentMessages({
        kind: 'messages',
        messages: [{ kind: 'reply', text, at: 1 }],
        hasOlder: false
      })
      expect(JSON.stringify(result)).not.toContain('SKILL.md')
      expect(JSON.stringify(result)).toContain('$demo')
    })
  }
})

describe('nothing persists or logs', () => {
  async function tree(folder: string): Promise<string[]> {
    const names: string[] = []
    for (const entry of await readdir(folder, { withFileTypes: true, recursive: true })) {
      if (entry.isFile()) names.push(join(entry.parentPath, entry.name))
    }
    return names
  }

  it('reads with the switch on leave no sentinel in the state folder, console or process output', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'agentpeek-m2-adversarial-'))
    folders.push(folder)
    const port = await freePort()
    const { saveRemoteSettings, REMOTE_SETTINGS_FILE } = await import('./settings')
    await saveRemoteSettings(folder, {
      enabled: true,
      ownerLogin: OWNER,
      hostName: HOST,
      port,
      sharedWorkspaces: [SHARED],
      shareTitles: false
    })
    const output: string[] = []
    for (const method of ['log', 'info', 'debug', 'warn', 'error', 'trace'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        output.push(args.map(String).join(' '))
      })
    }
    const writes: string[] = []
    for (const stream of [process.stdout, process.stderr]) {
      const original = stream.write.bind(stream)
      vi.spyOn(stream, 'write').mockImplementation((chunk: unknown, ...rest: unknown[]) => {
        writes.push(String(chunk))
        return Reflect.apply(original, stream, [chunk, ...rest]) as boolean
      })
    }
    const current = snapshot()
    const recentMessages = vi.fn((key: SessionKey) => {
      if (key.id === B.id)
        return Promise.reject(new Error(`${SENTINEL} reader failure at ${SHARED}`))
      return Promise.resolve(messagesOf(key))
    })
    const view = createRemoteView({
      folder,
      viewerFolder: join(folder, 'no-viewer-build'),
      snapshot: () => current,
      recentMessages
    })
    views.push(view)
    await view.open()
    const stream = subscribe(port)
    await expect.poll(() => stream.frames.length).toBe(1)
    expect(view.setShareMessages(true)).toEqual({ ok: true })
    await expect.poll(() => stream.frames.length).toBe(2)
    const ids = (stream.frames[1] as StatusFrame).status.projects[0]!.sessions.map((row) => row.id)
    const bodies = await Promise.all(
      ids.map((id) => send(port, { path: REMOTE_ROUTES.messages(id) }).then((reply) => reply.body))
    )
    expect(bodies.join('')).toContain(SENTINEL) // the shared reply was sent to the owner
    expect(recentMessages).toHaveBeenCalledTimes(2)
    stream.disconnect()
    await view.close()
    const files = await tree(folder)
    expect(files.map((file) => file.slice(folder.length + 1))).toEqual([REMOTE_SETTINGS_FILE])
    for (const file of files) {
      const content = await readFile(file, 'utf8')
      expect(content).not.toContain(SENTINEL)
      expect(content).not.toMatch(/message|details|raw-adversarial/i)
    }
    expect(output).toEqual([])
    expect(writes.join('')).not.toContain(SENTINEL)
    expect(stream.raw.join('')).not.toContain(SENTINEL)
  })
})
