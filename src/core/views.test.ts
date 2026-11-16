import { describe, expect, it } from 'vitest'
import type { Session, SessionActivity, SessionAttention } from './session'
import type { AgentTool } from './tools'
import { inboxGroupOf, buildView, sortSessions, type ViewContents } from './views'

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

describe('inboxGroupOf', () => {
  it('puts each session in the first group that matches', () => {
    expect(inboxGroupOf(session('a', { activity: WAITING, attention: { waiting: true } }))).toBe(
      'waiting'
    )
    expect(
      inboxGroupOf(session('b', { activity: WAITING, attention: { waiting: true, error: true } }))
    ).toBe('waiting')
    expect(inboxGroupOf(session('c', { activity: RUNNING, attention: { error: true } }))).toBeNull()
    expect(
      inboxGroupOf(session('d', { activity: RUNNING, attention: { newReply: true } }))
    ).toBeNull()
    expect(inboxGroupOf(session('e', { activity: RUNNING }))).toBeNull()
  })

  it('excludes Unknown sessions without unread results', () => {
    const unknown = (reason: 'process-ended' | 'app-not-running' | 'quiet' | 'unreadable') =>
      inboxGroupOf(session('u', { activity: { state: 'unknown', reason } }))
    expect(unknown('process-ended')).toBeNull()
    expect(unknown('app-not-running')).toBeNull()
    expect(unknown('quiet')).toBeNull()
    expect(unknown('unreadable')).toBeNull()
    expect(
      inboxGroupOf(session('v', { activity: { state: 'unknown', reason: 'unsupported' } }))
    ).toBeNull()
  })

  it('leaves out idle sessions with nothing to see', () => {
    expect(inboxGroupOf(session('i'))).toBeNull()
    expect(inboxGroupOf(session('j', { pinned: true }))).toBeNull()
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

  it('keeps only running sessions in Active, pinned first, then newest', () => {
    expect(layout(buildView(sessions, 'active', 'all'))).toEqual({
      running: ['running-pinned', 'running-2', 'running-1']
    })
  })

  it('puts Waiting first, then unread errors and replies in Inbox', () => {
    expect(layout(buildView(sessions, 'inbox', 'all'))).toEqual({
      waiting: ['waiting'],
      errors: ['error'],
      'new-replies': ['reply']
    })
    expect(buildView(sessions, 'inbox', 'all').groups.map((g) => g.id)).toEqual([
      'waiting',
      'errors',
      'new-replies'
    ])
  })

  it('moves finished replies and errors to Inbox, then back to Active on restart', () => {
    const activeIds = (s: Session) =>
      buildView([s], 'active', 'all').groups.flatMap((g) => g.sessions.map((s) => s.key.id))
    const inboxIds = (s: Session) =>
      buildView([s], 'inbox', 'all').groups.flatMap((g) => g.sessions.map((s) => s.key.id))
    for (const attention of [{ newReply: true }, { error: true }]) {
      const finished = session('task', { attention })
      expect(activeIds(finished)).toEqual([])
      expect(inboxIds(finished)).toEqual(['task'])
      const restarted = { ...finished, activity: RUNNING }
      expect(activeIds(restarted)).toEqual(['task'])
      expect(inboxIds(restarted)).toEqual([])
      const read = session('task')
      expect(inboxIds(read)).toEqual([])
      expect(layout(buildView([read], 'all', 'all'))).toEqual({ all: ['task'] })
    }
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
    expect(buildView(unpinnedIdle, 'inbox', 'all').groups).toEqual([])
    expect(buildView(unpinnedIdle, 'pinned', 'all').groups).toEqual([])
    expect(buildView([], 'all', 'all').groups).toEqual([])
  })

  it('filters by tool, and counts each tool in the view before filtering', () => {
    const active = buildView(sessions, 'active', 'claude')
    expect(layout(active)).toEqual({
      running: ['running-2']
    })
    expect(active.toolCounts).toEqual({ all: 3, codex: 2, claude: 1 })
    const inbox = buildView(sessions, 'inbox', 'claude')
    expect(layout(inbox)).toEqual({ waiting: ['waiting'], 'new-replies': ['reply'] })
    expect(inbox.toolCounts).toEqual({ all: 3, codex: 1, claude: 2 })
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
