import { describe, expect, it } from 'vitest'
import type { RemoteSession, RemoteStatus } from '../../../src/core/remote/status-projection'
import {
  durationText,
  NO_FILTERS,
  omittedText,
  rowStatus,
  rowTime,
  sourceIssues,
  statusView,
  summaryText
} from './status-view'

// Synthetic sessions only: aliases, invented folder names, opaque-looking IDs.

const NOW = 1_800_000_000_000
const MIN = 60_000

let next = 0
function session(change: Partial<RemoteSession> = {}): RemoteSession {
  next += 1
  return {
    id: `id-${String(next).padStart(19, '0')}`,
    tool: 'codex',
    title: `Session ${next}`,
    activity: { state: 'idle' },
    attention: { waiting: false, newReply: false, error: false },
    attentionSince: null,
    lastActivityAt: NOW - 5 * MIN,
    ...change
  }
}

const waiting = (change: Partial<RemoteSession> = {}) =>
  session({
    activity: { state: 'waiting', kind: 'permission' },
    attention: { waiting: true, newReply: false, error: false },
    ...change
  })
const errored = (since: number, change: Partial<RemoteSession> = {}) =>
  session({
    attention: { waiting: false, newReply: false, error: true },
    attentionSince: since,
    ...change
  })
const replied = (since: number, change: Partial<RemoteSession> = {}) =>
  session({
    attention: { waiting: false, newReply: true, error: false },
    attentionSince: since,
    ...change
  })

function status(projects: RemoteStatus['projects']): RemoteStatus {
  return {
    observedAt: NOW,
    sources: {
      codex: { state: 'connected', lastReadAt: NOW },
      claude: { state: 'connected', lastReadAt: NOW }
    },
    projects,
    omitted: { projects: 0, sessions: 0 }
  }
}

describe('rowStatus', () => {
  it.each([
    [waiting(), 'waiting', 'Waiting for you · Permission'],
    [waiting({ activity: { state: 'waiting', kind: 'other' } }), 'waiting', 'Waiting for you'],
    [errored(NOW), 'error', 'Error'],
    [replied(NOW), 'reply', 'New reply'],
    [
      session({ activity: { state: 'unknown', reason: 'quiet' } }),
      'unknown',
      'Unknown · Quiet for 30 min'
    ],
    [session({ activity: { state: 'running' } }), 'running', 'Running'],
    [session(), 'idle', 'Idle']
  ])('labels %#', (row, kind, label) => {
    expect(rowStatus(row)).toEqual({ kind, label })
  })

  it('puts waiting before an error, and an error before a new reply', () => {
    const all = { waiting: true, newReply: true, error: true }
    expect(rowStatus(waiting({ attention: all })).kind).toBe('waiting')
    expect(rowStatus(errored(NOW, { attention: { ...all, waiting: false } })).kind).toBe('error')
  })
})

describe('statusView', () => {
  it('groups attention across projects, waiting then errors then replies, oldest first', () => {
    const reply = replied(NOW - 9 * MIN)
    const lateError = errored(NOW - 1 * MIN)
    const earlyError = errored(NOW - 3 * MIN)
    const wait = waiting()
    const idle = session()
    const view = statusView(
      status([
        { label: 'alpha', sessions: [reply, lateError, idle] },
        { label: 'beta', sessions: [earlyError, wait] }
      ]),
      NO_FILTERS
    )
    expect(view.attention.map((row) => row.session.id)).toEqual([
      wait.id,
      earlyError.id,
      lateError.id,
      reply.id
    ])
    expect(view.attention[0]!.project).toBe('beta')
    expect(view.projects).toEqual([
      { label: 'alpha', rows: [expect.objectContaining({ session: idle })], total: 3 },
      { label: 'beta', rows: [], total: 2 }
    ])
    expect(view.counts).toEqual({ waiting: 1, error: 2, reply: 1 })
  })

  it('filters by project and tool, but counts every session', () => {
    const codex = session({ tool: 'codex' })
    const claude = session({ tool: 'claude' })
    const claudeWait = waiting({ tool: 'claude' })
    const other = session()
    const s = status([
      { label: 'alpha', sessions: [codex, claude, claudeWait] },
      { label: 'beta', sessions: [other] }
    ])
    const byTool = statusView(s, { project: null, tool: 'claude' })
    expect(byTool.attention.map((row) => row.session.id)).toEqual([claudeWait.id])
    expect(byTool.projects.map((p) => p.rows.map((row) => row.session.id))).toEqual([
      [claude.id],
      []
    ])
    expect(byTool.counts.waiting).toBe(1)

    const byProject = statusView(s, { project: 'beta', tool: null })
    expect(byProject.attention).toEqual([])
    expect(byProject.projects.map((p) => p.label)).toEqual(['beta'])
    expect(byProject.counts.waiting).toBe(1)
  })

  it('drops a project filter whose project is no longer shared', () => {
    const view = statusView(status([{ label: 'alpha', sessions: [session()] }]), {
      project: 'gone',
      tool: null
    })
    expect(view.filters.project).toBeNull()
    expect(view.projects.map((p) => p.label)).toEqual(['alpha'])
  })

  it('offers only filters that change something, and keeps an active one', () => {
    const one = statusView(status([{ label: 'alpha', sessions: [session()] }]), NO_FILTERS)
    expect(one.projectChoices).toEqual([])
    expect(one.toolChoices).toEqual([])
    const two = statusView(
      status([
        { label: 'alpha', sessions: [session({ tool: 'claude' })] },
        { label: 'beta', sessions: [session()] }
      ]),
      NO_FILTERS
    )
    expect(two.projectChoices).toEqual(['alpha', 'beta'])
    expect(two.toolChoices).toEqual(['codex', 'claude'])
    const kept = statusView(status([{ label: 'alpha', sessions: [session()] }]), {
      project: null,
      tool: 'claude'
    })
    expect(kept.toolChoices).toEqual(['codex', 'claude'])
  })
})

describe('times', () => {
  it('measures ages to the last check, never past it', () => {
    expect(durationText(30_000)).toBe('under 1 min')
    expect(durationText(4 * MIN + 59_000)).toBe('4 min')
    expect(durationText(3 * 60 * MIN)).toBe('3 h')
    expect(durationText(50 * 60 * MIN)).toBe('2 d')
    expect(durationText(-5 * MIN)).toBe('under 1 min')
  })

  it('gives a date instead of an age from a week on', () => {
    const [row] = statusView(
      status([
        { label: 'alpha', sessions: [session({ lastActivityAt: NOW - 8 * 24 * 60 * MIN })] }
      ]),
      NO_FILTERS
    ).projects[0]!.rows
    expect(rowTime(row!, NOW)?.text).toMatch(/^on \S/)
    expect(rowTime(row!, NOW)?.text).not.toMatch(/ago/)
  })

  it('gives attention rows how long, other rows when, and waiting-only rows nothing', () => {
    const view = statusView(
      status([
        {
          label: 'alpha',
          sessions: [
            errored(NOW - 4 * MIN),
            waiting(),
            session({ lastActivityAt: NOW - 2 * MIN }),
            session({ lastActivityAt: NOW - 10_000 })
          ]
        }
      ]),
      NO_FILTERS
    )
    const [wait, error] = view.attention
    expect(rowTime(error!, NOW)?.text).toBe('for 4 min')
    expect(rowTime(wait!, NOW)).toBeNull()
    expect(view.projects[0]!.rows.map((row) => rowTime(row, NOW)?.text)).toEqual([
      '2 min ago',
      'just now'
    ])
  })
})

describe('copy', () => {
  it('summarizes attention with plurals', () => {
    expect(summaryText({ waiting: 2, error: 1, reply: 1 })).toBe(
      '2 need you · 1 error · 1 new reply'
    )
    expect(summaryText({ waiting: 1, error: 2, reply: 3 })).toBe(
      '1 needs you · 2 errors · 3 new replies'
    )
    expect(summaryText({ waiting: 0, error: 0, reply: 0 })).toBe('')
  })

  it('names the sources the Mac cannot read', () => {
    expect(
      sourceIssues({
        codex: { state: 'unsupported' },
        claude: { state: 'no-access', lastReadAt: null }
      })
    ).toEqual(['Codex: unsupported format on the Mac.', 'Claude Code: no access on the Mac.'])
    expect(sourceIssues({ codex: { state: 'off' }, claude: { state: 'not-installed' } })).toEqual(
      []
    )
  })

  it('says what the budgets left out', () => {
    expect(omittedText({ projects: 0, sessions: 0 })).toBeNull()
    expect(omittedText({ projects: 1, sessions: 12 })).toBe(
      'Not everything fits: 1 project and 12 sessions left out.'
    )
  })
})
