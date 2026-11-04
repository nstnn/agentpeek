import { describe, expect, it } from 'vitest'
import type { RemoteSession, RemoteStatus } from '../../../src/core/remote/status-projection'
import {
  activeGroupOf,
  DEFAULT_CHOICES,
  durationText,
  listView,
  omittedText,
  rowStatus,
  rowTime,
  sourceIssues,
  sourceLines,
  viewSummary,
  type Row
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

describe('listView', () => {
  const projects = () => [
    {
      label: 'alpha',
      sessions: [
        errored(NOW - 4 * MIN, { lastActivityAt: NOW - 4 * MIN }),
        session({ tool: 'claude', activity: { state: 'running' }, lastActivityAt: NOW - MIN }),
        session({ lastActivityAt: NOW - 20 * MIN })
      ]
    },
    {
      label: 'beta',
      sessions: [
        waiting({ tool: 'claude', lastActivityAt: NOW - 2 * MIN }),
        replied(NOW - 3 * MIN, { lastActivityAt: NOW - 3 * MIN }),
        session({ activity: { state: 'unknown', reason: 'quiet' }, lastActivityAt: NOW - 9 * MIN }),
        session({ activity: { state: 'unknown', reason: 'unreadable' } })
      ]
    }
  ]

  it('groups the Active view by status in the desktop order, newest first', () => {
    const view = listView(status(projects()), DEFAULT_CHOICES)
    expect(view.groups.map((group) => [group.label, group.note, group.rows.length])).toEqual([
      ['Waiting for you', '1 outstanding', 1],
      ['Errors', '1 outstanding', 1],
      ['New replies', '1 outstanding', 1],
      ['Running', '1 current', 1],
      ['Unknown', '1 current', 1]
    ])
    // Idle and an unreadable unknown are not active, as on the desktop.
    expect(view.shown).toBe(5)
    expect(view.needsAttention).toBe(3)
    expect(view.total).toBe(7)
  })

  it('shows every session, newest first, in All Sessions', () => {
    const view = listView(status(projects()), { ...DEFAULT_CHOICES, view: 'all' })
    expect(view.groups).toHaveLength(1)
    expect(view.groups[0]!.label).toBe('All Sessions')
    const ages = view.groups[0]!.rows.map((row) => NOW - row.session.lastActivityAt)
    expect(ages).toEqual([...ages].sort((x, y) => x - y))
    expect(view.shown).toBe(7)
  })

  it('groups by project in the order the Mac shares them, with attention and running notes', () => {
    const view = listView(status(projects()), { ...DEFAULT_CHOICES, grouping: 'project' })
    expect(view.groups.map((group) => [group.label, group.note])).toEqual([
      ['alpha', '1 need attention · 1 running'],
      ['beta', '2 need attention']
    ])
  })

  it('filters by tool and counts each tool in the view before filtering', () => {
    const view = listView(status(projects()), { ...DEFAULT_CHOICES, tool: 'claude' })
    expect(view.toolCounts).toEqual({ all: 5, codex: 3, claude: 2 })
    expect(view.shown).toBe(2)
    expect(view.groups.map((group) => group.label)).toEqual(['Waiting for you', 'Running'])
  })

  it('offers the tool filter only when both tools have sessions, or one is chosen', () => {
    const codexOnly = status([{ label: 'alpha', sessions: [session()] }])
    expect(listView(codexOnly, DEFAULT_CHOICES).toolChoices).toBe(false)
    expect(listView(codexOnly, { ...DEFAULT_CHOICES, tool: 'claude' }).toolChoices).toBe(true)
    expect(listView(status(projects()), DEFAULT_CHOICES).toolChoices).toBe(true)
  })

  it('puts a session in the first matching Active group only', () => {
    expect(
      activeGroupOf(waiting({ attention: { waiting: true, newReply: true, error: true } }))
    ).toBe('waiting')
    expect(activeGroupOf(errored(NOW, { activity: { state: 'running' } }))).toBe('errors')
    expect(activeGroupOf(session())).toBeNull()
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
    const [row] = listView(
      status([
        { label: 'alpha', sessions: [session({ lastActivityAt: NOW - 8 * 24 * 60 * MIN })] }
      ]),
      { ...DEFAULT_CHOICES, view: 'all' }
    ).groups[0]!.rows
    expect(rowTime(row!, NOW)?.text).toMatch(/^on \S/)
    expect(rowTime(row!, NOW)?.text).not.toMatch(/ago/)
  })

  it('gives attention rows how long, other rows when, and waiting-only rows nothing', () => {
    const row = (value: RemoteSession): Row => ({
      session: value,
      project: 'alpha',
      ...rowStatus(value)
    })
    expect(rowTime(row(errored(NOW - 4 * MIN)), NOW)?.text).toBe('for 4 min')
    expect(rowTime(row(waiting()), NOW)).toBeNull()
    expect(rowTime(row(session({ lastActivityAt: NOW - 2 * MIN })), NOW)?.text).toBe('2 min ago')
    expect(rowTime(row(session({ lastActivityAt: NOW - 10_000 })), NOW)?.text).toBe('just now')
  })
})

describe('copy', () => {
  it('summarizes the shared sessions like the desktop list header', () => {
    const shared = status([
      {
        label: 'alpha',
        sessions: [waiting(), errored(NOW), session({ activity: { state: 'running' } }), session()]
      }
    ])
    expect(viewSummary(shared)).toBe('2 need attention · 1 running · 0 unknown')
  })

  it('names each source and its state for the sidebar', () => {
    const lines = sourceLines({
      codex: { state: 'connected', lastReadAt: NOW },
      claude: { state: 'no-access', lastReadAt: null }
    })
    expect(lines.map((line) => `${line.name}: ${line.text}`)).toEqual([
      'Codex: Connected',
      'Claude Code: No access'
    ])
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
