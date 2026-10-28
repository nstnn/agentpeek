import { describe, expect, it } from 'vitest'
import type { Session, SessionActivity, SessionAttention } from './session'
import { countGroups, createSnapshot, type LocalStateStatus, type SnapshotInput } from './snapshot'
import type { AgentTool } from './tools'

// Synthetic sessions only. `lastActivityAt` is in minutes to keep the order easy to read.
const NO_ATTENTION: SessionAttention = { waiting: false, newReply: false, error: false }

function session(
  id: string,
  options: {
    tool?: AgentTool
    activity?: SessionActivity
    attention?: Partial<SessionAttention>
    pinned?: boolean
    minute?: number
  } = {}
): Session {
  return {
    key: { tool: options.tool ?? 'codex', id },
    summary: {
      title: null,
      workspacePath: null,
      lastActivityAt: (options.minute ?? 0) * 60 * 1000,
      toolVersion: null
    },
    activity: options.activity ?? { state: 'idle' },
    attention: { ...NO_ATTENTION, ...options.attention },
    lastReply: null,
    pinned: options.pinned ?? false
  }
}

function input(sessions: Session[]): SnapshotInput {
  return {
    sessions,
    health: { codex: { state: 'checking' }, claude: { state: 'not-installed' } },
    localState: { kind: 'available' },
    firstLaunch: false,
    fixture: true,
    takenAt: 42
  }
}

const WAITING: SessionActivity = { state: 'waiting', waitingFor: 'input needed' }

describe('countGroups', () => {
  it('counts each session in its current status group, plus the Pinned and All views', () => {
    const counts = countGroups([
      session('a', { activity: WAITING, attention: { waiting: true, error: true } }),
      session('b', { activity: { state: 'running' }, attention: { error: true } }),
      session('c', { attention: { newReply: true }, pinned: true }),
      session('d', { activity: { state: 'running' } }),
      session('e', { activity: { state: 'unknown', reason: 'process-ended' } }),
      session('f', { activity: { state: 'unknown', reason: 'unreadable' }, pinned: true }),
      session('g')
    ])
    expect(counts).toEqual({
      waiting: 0,
      errors: 1,
      'new-replies': 1,
      running: 2,
      unknown: 1,
      pinned: 2,
      all: 7
    })
  })
})

describe('createSnapshot', () => {
  it('lists the sessions newest first and counts each one needing attention once', () => {
    const snapshot = createSnapshot(
      input([
        session('old', { minute: 1, attention: { newReply: true } }),
        session('new', { minute: 9, activity: WAITING, attention: { waiting: true, error: true } }),
        session('mid', { minute: 5, tool: 'claude' })
      ])
    )
    expect(snapshot.sessions.map((s) => s.key.id)).toEqual(['new', 'mid', 'old'])
    expect(snapshot.needsAttention).toBe(2)
    expect(snapshot.groupCounts.all).toBe(3)
    expect(snapshot).toMatchObject({
      health: { codex: { state: 'checking' }, claude: { state: 'not-installed' } },
      localState: { kind: 'available' },
      firstLaunch: false,
      fixture: true,
      takenAt: 42
    })
  })

  it('is a frozen copy at every level, so a published snapshot never changes', () => {
    const health: SnapshotInput['health'] = {
      codex: { state: 'connected', lastReadAt: 1 },
      claude: { state: 'checking' }
    }
    const localState: LocalStateStatus = { kind: 'unavailable', reason: 'unwritable' }
    const original: Session = {
      ...session('a', { attention: { newReply: true } }),
      lastReply: {
        cursor: 'turn-1',
        completedAt: 1,
        isError: false,
        errorCode: null,
        newerTurnStarted: false
      }
    }
    const snapshot = createSnapshot({ ...input([original]), health, localState })
    const [copy] = snapshot.sessions
    expect(copy).toEqual(original)
    const parts = [
      snapshot,
      snapshot.sessions,
      copy,
      copy?.key,
      copy?.summary,
      copy?.activity,
      copy?.attention,
      copy?.lastReply,
      snapshot.groupCounts,
      snapshot.health,
      snapshot.health.codex,
      snapshot.health.claude,
      snapshot.localState
    ]
    for (const part of parts) expect(Object.isFrozen(part)).toBe(true)

    // No object is shared with the input, which belongs to the sources and the store.
    expect(copy).not.toBe(original)
    expect(copy?.summary).not.toBe(original.summary)
    expect(copy?.lastReply).not.toBe(original.lastReply)
    expect(snapshot.health.codex).not.toBe(health.codex)
    expect(snapshot.localState).not.toBe(localState)
    expect(Object.isFrozen(original.summary)).toBe(false)
    expect(Object.isFrozen(original.lastReply)).toBe(false)
    expect(Object.isFrozen(health.codex)).toBe(false)

    // Changing the input afterwards does not reach the snapshot.
    original.summary.title = 'Changed'
    health.codex = { state: 'not-installed' }
    expect(copy?.summary.title).toBeNull()
    expect(snapshot.health.codex).toEqual({ state: 'connected', lastReadAt: 1 })
  })
})
