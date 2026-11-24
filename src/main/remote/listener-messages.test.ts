import { createHmac } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodeMessages, REMOTE_ROUTES, type StatusFrame } from '../../core/remote/protocol'
import type { RemoteSharing } from '../../core/remote/share-policy'
import {
  sessionKeyToString,
  type RecentMessages,
  type Session,
  type SessionKey
} from '../../core/session'
import { createSnapshot, type SessionsSnapshot } from '../../core/snapshot'
import type { ToolHealth } from '../../core/health'
import type { AgentTool } from '../../core/tools'
import { testSession } from '../test-support'
import { freePort, HOST, OWNER_HEADERS, OWNER, send, subscribe } from './http-test-support'
import { startRemoteListener, type RemoteListener, type RemoteListenerOptions } from './listener'
import { createSessionIdMinter } from './session-ids'

// Protocol v2 recent messages on the listener (TASK-032). Synthetic data only; SENTINEL text marks
// what must never reach a response.

const SHARED = '/Users/synthetic/projects/shared-demo'
const UNSHARED = '/Users/sentinel-user/private-root'
const SECRET = new Uint8Array(32).fill(7)
const mint = createSessionIdMinter(SECRET)

const CODEX: SessionKey = { tool: 'codex', id: 'SENTINEL-RAW-ID' }
const CLAUDE: SessionKey = { tool: 'claude', id: 'SENTINEL-RAW-ID-2' }
const HIDDEN: SessionKey = { tool: 'codex', id: 'SENTINEL-RAW-ID-3' }

const TEXT = {
  prompt: 'Synthetic prompt about the demo',
  reply: 'Synthetic reply with [$demo](/Users/sentinel-user/.agents/skills/demo/SKILL.md)',
  error: 'SENTINEL-ERROR-TEXT',
  tool: 'SENTINEL-TOOL-NAME'
}

const MESSAGES: RecentMessages = {
  kind: 'messages',
  messages: [
    { kind: 'prompt', text: TEXT.prompt, at: 10 },
    { kind: 'tool-calls', count: 2, names: [TEXT.tool], at: 11 },
    { kind: 'reply', text: TEXT.reply, at: 12 }
  ],
  hasOlder: false,
  error: { cursor: 'SENTINEL-CURSOR', message: TEXT.error }
}

function session(key: SessionKey, workspacePath: string): Session {
  return testSession({
    key,
    summary: {
      title: 'SENTINEL-TITLE',
      workspacePath,
      lastActivityAt: 5,
      toolVersion: 'SENTINEL-VERSION'
    }
  })
}

function snapshot(
  health: Partial<Record<'codex' | 'claude', ToolHealth>> = {},
  takenAt = 1
): SessionsSnapshot {
  return createSnapshot({
    sessions: [session(CODEX, SHARED), session(CLAUDE, SHARED), session(HIDDEN, UNSHARED)],
    health: {
      codex: { state: 'connected', lastReadAt: 1 },
      claude: { state: 'connected', lastReadAt: 1 },
      ...health
    },
    localState: { kind: 'available' },
    firstLaunch: false,
    fixture: true,
    takenAt
  })
}

type Reader = NonNullable<RemoteListenerOptions['readMessages']>

/** A reader that answers `result` at once. */
const answering = (result: RecentMessages = MESSAGES) =>
  vi.fn<Reader>(() => Promise.resolve(result))

/** A reader that waits until the test lets it finish, to change the policy meanwhile. */
function gatedReader(result: RecentMessages = MESSAGES) {
  const waiting: (() => void)[] = []
  const reader = vi.fn<Reader>(
    () => new Promise<RecentMessages>((done) => waiting.push(() => done(result)))
  )
  return {
    reader,
    started: () => reader.mock.calls.length,
    release: () => waiting.splice(0).forEach((finish) => finish())
  }
}

interface Policy {
  snapshot: SessionsSnapshot
  sharing: RemoteSharing
  generation: number
  details: boolean
}

const listeners: RemoteListener[] = []

async function start(reader: Reader = answering(), change: Partial<Policy> = {}) {
  const policy: Policy = {
    snapshot: snapshot(),
    sharing: { sharedWorkspaces: [SHARED], shareTitles: false },
    generation: 1,
    details: true,
    ...change
  }
  const result = await startRemoteListener({
    port: await freePort(),
    access: { ownerLogin: OWNER, hostName: HOST },
    secret: SECRET,
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
  const { listener } = result
  return {
    listener,
    policy,
    port: listener.port,
    get: (key: SessionKey | string, headers: Record<string, string> = { ...OWNER_HEADERS }) =>
      send(listener.port, {
        path: REMOTE_ROUTES.messages(typeof key === 'string' ? key : mint(key)),
        headers
      })
  }
}

afterEach(async () => {
  await Promise.all(listeners.splice(0).map((listener) => listener.close('shutdown')))
})

const error = (body: string) => (JSON.parse(body) as { error: string }).error

/** Every error body is the fixed code shape: nothing from the request, the reader or a path. */
function generic(body: string): void {
  expect(Object.keys(JSON.parse(body) as object).sort()).toEqual(['error', 'v'])
  expect(body).not.toMatch(/SENTINEL|Synthetic|\/Users\//)
}

describe('recent-messages route', () => {
  it('answers the projected entries of a shared session through the bounded reader', async () => {
    const reader = answering()
    const h = await start(reader)
    const reply = await h.get(CODEX)
    expect(reply.status).toBe(200)
    expect(reply.headers['cache-control']).toBe('no-store')
    expect(reply.headers['content-type']).toBe('application/json')
    expect(reply.headers['content-security-policy']).toContain("default-src 'none'")
    const decoded = decodeMessages(reply.body)
    if (!decoded.ok) throw new Error(decoded.error)
    expect(decoded.response).toEqual({
      v: 2,
      type: 'messages',
      session: mint(CODEX),
      generation: 1,
      sentAt: 1_000,
      result: {
        state: 'messages',
        entries: [
          { kind: 'prompt', text: TEXT.prompt, at: 10, cut: false },
          { kind: 'tool-calls', count: 2, at: 11 },
          { kind: 'reply', text: 'Synthetic reply with $demo', at: 12, cut: false }
        ],
        older: false
      }
    })
    expect(reply.body).not.toMatch(/SENTINEL|\/Users\//)
    expect(reader).toHaveBeenCalledExactlyOnceWith(CODEX, 20)
  })

  it('carries details in every status frame', async () => {
    const h = await start(undefined, { details: false })
    const viewer = subscribe(h.port)
    await expect.poll(() => viewer.frames.length).toBe(1)
    expect((viewer.frames[0] as StatusFrame).details).toBe(false)
    h.policy.details = true
    h.policy.generation += 1
    h.listener.resync()
    await expect.poll(() => viewer.frames.length).toBe(2)
    expect(viewer.frames[1]).toMatchObject({ details: true, generation: 2 })
    viewer.disconnect()
  })

  it('answers details-off while the switch is off, without reading', async () => {
    const reader = answering()
    const h = await start(reader, { details: false })
    const reply = await h.get(CODEX)
    expect(reply.status).toBe(403)
    expect(error(reply.body)).toBe('details-off')
    generic(reply.body)
    expect(reader).not.toHaveBeenCalled()
  })

  it('checks the login first: another login learns nothing and reads nothing', async () => {
    const reader = answering()
    const h = await start(reader)
    for (const headers of [
      { Host: HOST } as Record<string, string>,
      { Host: HOST, 'Tailscale-User-Login': 'someone-else@example.com' }
    ]) {
      const reply = await h.get(CODEX, headers)
      expect(reply.status).toBe(403)
      expect(error(reply.body)).toBe('not-allowed')
    }
    expect(reader).not.toHaveBeenCalled()
  })

  it('gives the same not-found for unshared, source-off, rotated and guessed IDs', async () => {
    const reader = answering()
    const h = await start(reader, { snapshot: snapshot({ claude: { state: 'off' } }) })
    const rotated = createSessionIdMinter(new Uint8Array(32).fill(8))(CODEX)
    const bodies = new Set<string>()
    for (const id of [mint(HIDDEN), mint(CLAUDE), rotated, 'AAAAAAAAAAAAAAAAAAAAAA']) {
      const reply = await h.get(id)
      expect(reply.status, id).toBe(404)
      generic(reply.body)
      bodies.add(reply.body)
    }
    expect([...bodies]).toEqual(['{"v":2,"error":"not-found"}'])
    expect(reader).not.toHaveBeenCalled()
  })

  it('answers the reader states without its details', async () => {
    const thrown = vi.fn<Reader>(() =>
      Promise.reject(new Error(`SENTINEL exception at ${UNSHARED}`))
    )
    const h = await start(thrown)
    const reply = await h.get(CODEX)
    expect(decodeMessages(reply.body)).toMatchObject({
      ok: true,
      response: { result: { state: 'unavailable', reason: 'unreadable' } }
    })
    expect(reply.body).not.toMatch(/SENTINEL|\/Users\//)

    const gone = await start(answering({ kind: 'not-found' }))
    const missing = await gone.get(CODEX)
    expect(missing.status).toBe(404)
    generic(missing.body)

    const empty = await start(answering({ kind: 'messages', messages: [], hasOlder: false }))
    expect(JSON.parse((await empty.get(CODEX)).body)).toMatchObject({
      result: { state: 'unavailable', reason: 'empty' }
    })
  })

  it('answers unsupported for a session of an unsupported source, without reading', async () => {
    const reader = answering()
    const h = await start(reader, {
      snapshot: snapshot({ codex: { state: 'unsupported', toolVersion: 'SENTINEL-VERSION' } })
    })
    const reply = await h.get(CODEX)
    expect(JSON.parse(reply.body)).toMatchObject({
      result: { state: 'unavailable', reason: 'unsupported' }
    })
    expect(reader).not.toHaveBeenCalled()
  })

  it('allows two reads in progress and answers a third busy', async () => {
    const gate = gatedReader()
    const h = await start(gate.reader)
    const first = h.get(CODEX)
    const second = h.get(CLAUDE)
    await expect.poll(gate.started).toBe(2)
    const third = await h.get(CODEX)
    expect(third.status).toBe(503)
    expect(third.headers['retry-after']).toBe('5')
    expect(error(third.body)).toBe('busy')
    gate.release()
    expect((await first).status).toBe(200)
    expect((await second).status).toBe(200)
    // The slots are free again once the reads end.
    const fourth = h.get(CODEX)
    await expect.poll(gate.started).toBe(3)
    gate.release()
    expect((await fourth).status).toBe(200)
  })
})

describe('recent-messages policy changes during the read', () => {
  async function racing(change: (h: Awaited<ReturnType<typeof start>>) => void | Promise<void>) {
    const gate = gatedReader()
    const h = await start(gate.reader)
    const pending = h.get(CODEX)
    await expect.poll(gate.started).toBe(1)
    await change(h)
    gate.release()
    const reply = await pending
    expect(reply.body).not.toMatch(/Synthetic|SENTINEL|\/Users\//)
    return reply
  }

  it('the switch turned off gives details-off', async () => {
    const reply = await racing((h) => {
      h.policy.details = false
      h.policy.generation += 1
    })
    expect([reply.status, error(reply.body)]).toEqual([403, 'details-off'])
  })

  it('the folder unshared gives not-found', async () => {
    const reply = await racing((h) => {
      h.policy.sharing = { sharedWorkspaces: [], shareTitles: false }
      h.policy.generation += 1
    })
    expect([reply.status, error(reply.body)]).toEqual([404, 'not-found'])
  })

  it('the source turned off gives not-found', async () => {
    const reply = await racing((h) => {
      h.policy.snapshot = snapshot({ codex: { state: 'off' } }, 2)
      h.listener.publish(h.policy.snapshot)
      h.policy.generation += 1
    })
    expect([reply.status, error(reply.body)]).toEqual([404, 'not-found'])
  })

  it('any other generation change gives policy-changed', async () => {
    const reply = await racing((h) => {
      h.policy.sharing = { sharedWorkspaces: [SHARED], shareTitles: true }
      h.policy.generation += 1
    })
    expect([reply.status, error(reply.body)]).toEqual([409, 'policy-changed'])
  })

  it('a login or Mac address change, which closes the listener, gives not-allowed', async () => {
    const reply = await racing((h) => void h.listener.close('access-changed'))
    expect([reply.status, error(reply.body)]).toEqual([403, 'not-allowed'])
  })

  it('Remote View turned off gives details-off', async () => {
    const reply = await racing((h) => void h.listener.close('remote-off'))
    expect([reply.status, error(reply.body)]).toEqual([403, 'details-off'])
  })

  it('sleep gives policy-changed', async () => {
    const reply = await racing((h) => h.listener.suspend())
    expect([reply.status, error(reply.body)]).toEqual([409, 'policy-changed'])
  })

  it('sleep and wake during the read still gives policy-changed (TASK-035 C1)', async () => {
    const reply = await racing((h) => {
      h.listener.suspend()
      h.listener.resume()
    })
    expect([reply.status, error(reply.body)]).toEqual([409, 'policy-changed'])
  })

  it('a new snapshot that keeps the session and generation still answers', async () => {
    const gate = gatedReader()
    const h = await start(gate.reader)
    const pending = h.get(CODEX)
    await expect.poll(gate.started).toBe(1)
    h.policy.snapshot = snapshot({}, 3)
    h.listener.publish(h.policy.snapshot)
    gate.release()
    expect((await pending).status).toBe(200)
  })

  it('refuses a forged opaque ID for an ineligible Antigravity session in a mixed shared workspace without reading', async () => {
    const ANTIGRAVITY = 'antigravity' as unknown as AgentTool
    const AG_KEY: SessionKey = { tool: ANTIGRAVITY, id: 'SENTINEL-AG-RAW-ID' }
    const forgedId = createHmac('sha256', Buffer.from(SECRET))
      .update(sessionKeyToString(AG_KEY))
      .digest()
      .subarray(0, 16)
      .toString('base64url')
    const base = snapshot()
    const mixed: SessionsSnapshot = {
      ...base,
      sessions: [...base.sessions, session(AG_KEY, SHARED)],
      health: {
        ...base.health,
        antigravity: { state: 'connected', lastReadAt: 1 }
      } as SessionsSnapshot['health']
    }
    const reader = answering()
    const h = await start(reader, { snapshot: mixed })
    const reply = await h.get(forgedId)
    expect(reply.status).toBe(404)
    expect(error(reply.body)).toBe('not-found')
    generic(reply.body)
    expect(reader).not.toHaveBeenCalled()
  })

  it('completes an eligible read even when Antigravity-only changes arrive during the read', async () => {
    const ANTIGRAVITY = 'antigravity' as unknown as AgentTool
    const AG_KEY: SessionKey = { tool: ANTIGRAVITY, id: 'SENTINEL-AG-MID-READ' }
    const gate = gatedReader()
    const h = await start(gate.reader)
    const pending = h.get(CODEX)
    await expect.poll(gate.started).toBe(1)
    const base = snapshot({}, 4)
    h.policy.snapshot = {
      ...base,
      sessions: [...base.sessions, session(AG_KEY, SHARED)],
      health: {
        ...base.health,
        antigravity: { state: 'off' }
      } as SessionsSnapshot['health']
    }
    h.listener.publish(h.policy.snapshot)
    gate.release()
    expect((await pending).status).toBe(200)
  })
})
