import { describe, expect, it } from 'vitest'
import type { Session, SessionActivity, SessionAttention } from './session'
import type { AgentTool } from './tools'
import { activeGroupOf, buildView, sortSessions, type ViewContents } from './views'

// Synthetic sessions only. `lastActivityAt` is in minutes to keep the order easy to read.
const NO_ATTENTION: SessionAttention = { waiting: false, newReply: false, error: false }

interface SessionOptions {
  tool?: AgentTool
  activity?: SessionActivity
  attention?: Partial<SessionAttention>
  pinned?: boolean
  minute?: number
}

function session(id: string, options: SessionOptions = {}): Session {
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

const RUNNING: SessionActivity = { state: 'running' }
const WAITING: SessionActivity = { state: 'waiting', waitingFor: 'permission prompt' }

/** The view as group IDs with the session IDs in each, which reads well in assertions. */
function layout(contents: ViewContents): Record<string, string[]> {
  return Object.fromEntries(
    contents.groups.map((group) => [group.id, group.sessions.map((s) => s.key.id)])
  )
}

describe('activeGroupOf', () => {
  it('puts each session in the first group that matches', () => {
    expect(activeGroupOf(session('a', { activity: WAITING, attention: { waiting: true } }))).toBe(
      'waiting'
    )
    expect(
      activeGroupOf(session('b', { activity: WAITING, attention: { waiting: true, error: true } }))
    ).toBe('waiting')
    expect(activeGroupOf(session('c', { activity: RUNNING, attention: { error: true } }))).toBe(
      'errors'
    )
    expect(activeGroupOf(session('d', { activity: RUNNING, attention: { newReply: true } }))).toBe(
      'new-replies'
    )
    expect(activeGroupOf(session('e', { activity: RUNNING }))).toBe('running')
  })

  it('keeps only open-looking Unknown sessions', () => {
    const unknown = (reason: 'process-ended' | 'app-not-running' | 'quiet' | 'unreadable') =>
      activeGroupOf(session('u', { activity: { state: 'unknown', reason } }))
    expect(unknown('process-ended')).toBe('unknown')
    expect(unknown('app-not-running')).toBe('unknown')
    expect(unknown('quiet')).toBe('unknown')
    expect(unknown('unreadable')).toBeNull()
    expect(
      activeGroupOf(session('v', { activity: { state: 'unknown', reason: 'unsupported' } }))
    ).toBeNull()
  })

  it('leaves out idle sessions with nothing to see', () => {
    expect(activeGroupOf(session('i'))).toBeNull()
    expect(activeGroupOf(session('j', { pinned: true }))).toBeNull()
  })
})

describe('buildView', () => {
  const sessions = [
    session('idle-old', { minute: 1 }),
    session('running-1', { activity: RUNNING, minute: 10 }),
    session('running-2', { activity: RUNNING, minute: 20, tool: 'claude' }),
    session('running-pinned', { activity: RUNNING, minute: 5, pinned: true }),
    session('reply', { attention: { newReply: true }, minute: 30, tool: 'claude' }),
    session('error', { attention: { error: true }, minute: 2 }),
    session('waiting', {
      activity: WAITING,
      attention: { waiting: true },
      minute: 3,
      tool: 'claude'
    }),
    session('gone', { activity: { state: 'unknown', reason: 'process-ended' }, minute: 4 }),
    session('broken', { activity: { state: 'unknown', reason: 'unreadable' }, minute: 50 }),
    session('idle-pinned', { minute: 0, pinned: true, tool: 'claude' })
  ]

  it('groups the Active view in the approved order, pinned first, then newest', () => {
    expect(layout(buildView(sessions, 'active', 'all'))).toEqual({
      waiting: ['waiting'],
      errors: ['error'],
      'new-replies': ['reply'],
      running: ['running-pinned', 'running-2', 'running-1'],
      unknown: ['gone']
    })
    expect(buildView(sessions, 'active', 'all').groups.map((group) => group.id)).toEqual([
      'waiting',
      'errors',
      'new-replies',
      'running',
      'unknown'
    ])
  })

  it('hides empty groups', () => {
    const contents = buildView([session('r', { activity: RUNNING })], 'active', 'all')
    expect(contents.groups.map((group) => group.id)).toEqual(['running'])
  })

  it('shows every pinned session in one group, newest first', () => {
    expect(layout(buildView(sessions, 'pinned', 'all'))).toEqual({
      pinned: ['running-pinned', 'idle-pinned']
    })
  })

  it('shows every session in All Sessions, pinned first, then newest', () => {
    expect(layout(buildView(sessions, 'all', 'all'))).toEqual({
      all: [
        'running-pinned',
        'idle-pinned',
        'broken',
        'reply',
        'running-2',
        'running-1',
        'gone',
        'waiting',
        'error',
        'idle-old'
      ]
    })
  })

  it('returns no groups for an empty view', () => {
    const unpinnedIdle = [session('a'), session('b')]
    expect(buildView(unpinnedIdle, 'active', 'all').groups).toEqual([])
    expect(buildView(unpinnedIdle, 'pinned', 'all').groups).toEqual([])
    expect(buildView([], 'all', 'all').groups).toEqual([])
  })

  it('filters by tool, and counts each tool in the view before filtering', () => {
    const active = buildView(sessions, 'active', 'claude')
    expect(layout(active)).toEqual({
      waiting: ['waiting'],
      'new-replies': ['reply'],
      running: ['running-2']
    })
    expect(active.toolCounts).toEqual({ all: 7, codex: 4, claude: 3 })
    expect(buildView(sessions, 'all', 'codex').toolCounts).toEqual({
      all: 10,
      codex: 6,
      claude: 4
    })
    expect(layout(buildView(sessions, 'pinned', 'codex'))).toEqual({ pinned: ['running-pinned'] })
  })
})

describe('sortSessions', () => {
  it('breaks ties by session key, whatever the input order', () => {
    const tied = [
      session('b', { minute: 5 }),
      session('a', { minute: 5, tool: 'claude' }),
      session('a', { minute: 5 })
    ]
    const ids = (list: Session[]) => list.map((s) => `${s.key.tool}:${s.key.id}`)
    expect(ids(sortSessions(tied, true))).toEqual(['claude:a', 'codex:a', 'codex:b'])
    expect(ids(sortSessions([...tied].reverse(), true))).toEqual(['claude:a', 'codex:a', 'codex:b'])
  })

  it('does not change the list it is given', () => {
    const list = [session('old', { minute: 1 }), session('new', { minute: 2 })]
    sortSessions(list, false)
    expect(list.map((s) => s.key.id)).toEqual(['old', 'new'])
  })
})
