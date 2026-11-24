import { describe, expect, it, vi } from 'vitest'
import type { ToolHealth } from '../health'
import type { Session, SessionActivity, SessionAttention, SessionKey } from '../session'
import { createSnapshot, type SessionsSnapshot } from '../snapshot'
import type { AgentTool } from '../tools'
import {
  projectRemoteStatus,
  REMOTE_SESSION_FIELDS,
  REMOTE_STATUS_LIMITS,
  type RemoteProject,
  type RemoteStatus,
  type RemoteStatusPolicy,
  type SessionIdMinter
} from './status-projection'

// Synthetic sessions only. Every private value is a sentinel that must never appear in the output.
const SENTINELS = {
  path: '/Users/sentinel-user/private-root',
  title: 'SENTINEL-TITLE secret plan',
  waitingFor: 'SENTINEL-WAITING-FOR',
  errorCode: 'SENTINEL-ERROR-CODE',
  cursor: 'SENTINEL-CURSOR',
  rawId: 'SENTINEL-RAW-ID',
  version: 'SENTINEL-VERSION-9.9.9'
}

const NO_ATTENTION: SessionAttention = { waiting: false, newReply: false, error: false }

/** A stand-in minter for the pure module: deterministic and free of the raw ID. */
// Tests also mint IDs for plain session keys; the projection itself passes only remote keys.
const mintId: SessionIdMinter & ((key: SessionKey) => string) = (key: SessionKey) => {
  let hash = 0
  for (const char of `${key.tool}:${key.id}`) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return `opaque-${hash.toString(16).padStart(8, '0')}`
}

function session(
  id: string,
  options: {
    tool?: AgentTool
    workspace?: string | null
    title?: string | null
    activity?: SessionActivity
    attention?: Partial<SessionAttention>
    minute?: number
  } = {}
): Session {
  return {
    key: { tool: options.tool ?? 'codex', id: `${SENTINELS.rawId}-${id}` },
    summary: {
      title: options.title === undefined ? `${SENTINELS.title} ${id}` : options.title,
      workspacePath: options.workspace === undefined ? `${SENTINELS.path}/app` : options.workspace,
      lastActivityAt: (options.minute ?? 0) * 60 * 1000,
      toolVersion: SENTINELS.version
    },
    activity: options.activity ?? { state: 'idle' },
    attention: { ...NO_ATTENTION, ...options.attention },
    lastReply: {
      cursor: SENTINELS.cursor,
      completedAt: 1,
      isError: true,
      errorCode: SENTINELS.errorCode,
      newerTurnStarted: false
    },
    pinned: true
  }
}

function snapshot(sessions: Session[]): SessionsSnapshot {
  return createSnapshot({
    sessions,
    health: {
      codex: { state: 'connected', lastReadAt: 7 },
      claude: { state: 'unsupported', toolVersion: SENTINELS.version },
      antigravity: { state: 'not-installed' }
    },
    localState: { kind: 'available' },
    firstLaunch: false,
    fixture: true,
    takenAt: 42
  })
}

function policy(overrides: Partial<RemoteStatusPolicy> = {}): RemoteStatusPolicy {
  return { sharedWorkspaces: [`${SENTINELS.path}/app`], shareTitles: false, mintId, ...overrides }
}

function firstProject(status: RemoteStatus): RemoteProject {
  const project = status.projects[0]
  if (project === undefined) throw new Error('expected a project')
  return project
}

const ALL_SENTINELS = Object.values(SENTINELS)

function leaks(value: unknown, sentinels: readonly string[]): string[] {
  const json = JSON.stringify(value)
  return sentinels.filter((sentinel) => json.includes(sentinel))
}

describe('projectRemoteStatus privacy', () => {
  const waiting = session('w', {
    activity: { state: 'waiting', waitingFor: SENTINELS.waitingFor },
    attention: { waiting: true, error: true }
  })

  it('sends no path, title, tool text, cursor, raw ID, version, pin or fixture flag', () => {
    const status = projectRemoteStatus(snapshot([waiting, session('i')]), policy())
    expect(leaks(status, ALL_SENTINELS)).toEqual([])
    expect(JSON.stringify(status)).not.toMatch(/pinned|fixture|workspacePath|toolVersion/)
    expect(
      firstProject(status)
        .sessions.map((row) => row.title)
        .sort()
    ).toEqual(['Session 1', 'Session 2'])
  })

  it('sends the tool title only when title sharing is on', () => {
    const status = projectRemoteStatus(snapshot([waiting]), policy({ shareTitles: true }))
    expect(firstProject(status).sessions[0]?.title).toBe(`${SENTINELS.title} w`)
    const others = ALL_SENTINELS.filter((sentinel) => sentinel !== SENTINELS.title)
    expect(leaks(status, others)).toEqual([])
  })

  it('writes exactly the allowlisted fields for each session and the top level', () => {
    const status = projectRemoteStatus(snapshot([waiting]), policy())
    expect(Object.keys(status)).toEqual(['observedAt', 'sources', 'projects', 'omitted'])
    expect(Object.keys(firstProject(status))).toEqual(['label', 'sessions'])
    expect(Object.keys(firstProject(status).sessions[0] ?? {})).toEqual([...REMOTE_SESSION_FIELDS])
    expect(status.sources).toEqual({
      codex: { state: 'connected', lastReadAt: 7 },
      claude: { state: 'unsupported' }
    })
  })

  it('uses the minter for IDs and never the tool’s own ID', () => {
    const status = projectRemoteStatus(snapshot([waiting]), policy())
    expect(firstProject(status).sessions[0]?.id).toBe(mintId(waiting.key))
  })

  it('does not change the snapshot or read state', () => {
    const source = snapshot([waiting, session('i')])
    const before = structuredClone(source)
    const status = projectRemoteStatus(source, policy({ shareTitles: true }))
    const row = firstProject(status).sessions.find((r) => r.id === mintId(waiting.key))
    expect(row).toBeDefined()
    if (row) row.attention.error = false
    expect(source).toEqual(before)
    expect(source.sessions.find((s) => s.key.id === waiting.key.id)?.attention.error).toBe(true)
  })
})

describe('projectRemoteStatus scope', () => {
  it('shares exact folders only: no children, siblings, worktrees or no-folder sessions', () => {
    const base = `${SENTINELS.path}/app`
    const status = projectRemoteStatus(
      snapshot([
        session('exact', { workspace: base }),
        session('slash', { workspace: `${base}/` }),
        session('child', { workspace: `${base}/packages/web` }),
        session('sibling', { workspace: `${base}-worktree` }),
        session('none', { workspace: null }),
        session('relative', { workspace: 'app' })
      ]),
      policy()
    )
    expect(status.projects).toHaveLength(1)
    expect(
      firstProject(status)
        .sessions.map((row) => row.id)
        .sort()
    ).toEqual([mintId(session('exact').key), mintId(session('slash').key)].sort())
  })

  it('shares no row of a source that is off, even when the snapshot still lists it', () => {
    const listed = snapshot([session('codex'), session('claude', { tool: 'claude' })])
    const codexOff = { ...listed, health: { ...listed.health, codex: { state: 'off' as const } } }
    const status = projectRemoteStatus(codexOff, policy())
    expect(firstProject(status).sessions.map((row) => row.tool)).toEqual(['claude'])
    expect(status.sources.codex).toEqual({ state: 'off' })
  })

  it('shares nothing with an empty folder list, and lists shared folders without sessions', () => {
    const empty = projectRemoteStatus(snapshot([session('a')]), policy({ sharedWorkspaces: [] }))
    expect(empty.projects).toEqual([])
    const idle = projectRemoteStatus(snapshot([]), policy())
    expect(idle.projects).toEqual([{ label: 'app', sessions: [] }])
  })

  it('labels by folder name and numbers same-name folders in path order', () => {
    const status = projectRemoteStatus(
      snapshot([]),
      policy({
        sharedWorkspaces: ['/z/api', '/a/api', '/m/api 2', '/a/api/', '/', 'relative']
      })
    )
    expect(status.projects.map((project) => project.label)).toEqual(['api', 'api 2', 'api 3'])
    expect(leaks(status, ['/z', '/a', '/m'])).toEqual([])
  })

  it('cleans control and bidi characters from labels and titles', () => {
    const status = projectRemoteStatus(
      snapshot([session('a', { workspace: '/x/we‮ird\nname', title: 'line\none\u0007' })]),
      policy({ sharedWorkspaces: ['/x/we‮ird\nname'], shareTitles: true })
    )
    expect(firstProject(status).label).toBe('we ird name')
    expect(firstProject(status).sessions[0]?.title).toBe('line one')
  })
})

describe('projectRemoteStatus semantics', () => {
  it('keeps activity states, unknown reasons and attention flags, without waitingFor', () => {
    const status = projectRemoteStatus(
      snapshot([
        session('run', { activity: { state: 'running' }, minute: 4 }),
        session('wait', {
          activity: { state: 'waiting', waitingFor: SENTINELS.waitingFor },
          attention: { waiting: true },
          minute: 3
        }),
        session('unk', {
          activity: { state: 'unknown', reason: 'process-ended' },
          attention: { newReply: true },
          minute: 2
        }),
        session('idle', { attention: { error: true }, minute: 1 })
      ]),
      policy()
    )
    const rows = firstProject(status).sessions
    expect(
      rows.map((row) => [row.activity, row.attention, row.attentionSince, row.lastActivityAt])
    ).toEqual([
      [{ state: 'running' }, NO_ATTENTION, null, 4 * 60_000],
      [{ state: 'waiting', kind: 'other' }, { ...NO_ATTENTION, waiting: true }, null, 3 * 60_000],
      [
        { state: 'unknown', reason: 'process-ended' },
        { ...NO_ATTENTION, newReply: true },
        1,
        2 * 60_000
      ],
      [{ state: 'idle' }, { ...NO_ATTENTION, error: true }, 1, 60_000]
    ])
  })

  it('maps the waiting reason to a fixed kind and never sends the tool text', () => {
    const waiting = (id: string, waitingFor: string | null, minute: number) =>
      session(id, { activity: { state: 'waiting', waitingFor }, minute })
    const status = projectRemoteStatus(
      snapshot([
        waiting('perm', 'permission prompt', 6),
        waiting('sandbox', 'sandbox request', 5),
        waiting('question', 'input needed', 4),
        waiting('dialog', 'dialog open', 3.5),
        waiting('worker', 'worker request', 3),
        waiting('goal', 'goal proposal', 2.5),
        waiting('new', 'SENTINEL future value', 2),
        waiting('none', null, 1.5),
        waiting('proto', 'constructor', 1)
      ]),
      policy()
    )
    expect(firstProject(status).sessions.map((row) => row.activity)).toEqual([
      { state: 'waiting', kind: 'permission' },
      { state: 'waiting', kind: 'sandbox' },
      { state: 'waiting', kind: 'question' },
      { state: 'waiting', kind: 'dialog' },
      { state: 'waiting', kind: 'worker' },
      { state: 'waiting', kind: 'goal' },
      { state: 'waiting', kind: 'other' },
      { state: 'waiting', kind: 'other' },
      { state: 'waiting', kind: 'other' }
    ])
    expect(JSON.stringify(status)).not.toMatch(/prompt|request|needed|open|proposal|SENTINEL/)
  })

  it('keeps an alias when the session’s activity changes', () => {
    const a = session('a', { minute: 1 })
    const b = session('b', { minute: 2 })
    const aliasOf = (status: ReturnType<typeof projectRemoteStatus>, key: Session['key']) =>
      firstProject(status).sessions.find((row) => row.id === mintId(key))?.title
    const first = projectRemoteStatus(snapshot([a, b]), policy())
    const later = projectRemoteStatus(
      snapshot([{ ...a, summary: { ...a.summary, lastActivityAt: 9 * 60_000 } }, b]),
      policy()
    )
    expect(aliasOf(later, a.key)).toBe(aliasOf(first, a.key))
    expect(firstProject(later).sessions[0]?.id).toBe(mintId(a.key))
  })

  it('aliases a session without a title even when title sharing is on', () => {
    const status = projectRemoteStatus(
      snapshot([session('a', { title: null }), session('b', { title: '  ' })]),
      policy({ shareTitles: true })
    )
    expect(
      firstProject(status)
        .sessions.map((row) => row.title)
        .sort()
    ).toEqual(['Session 1', 'Session 2'])
  })

  it('reports the snapshot time as the observation time and passes health through', () => {
    const status = projectRemoteStatus(snapshot([]), policy())
    expect(status.observedAt).toBe(42)
  })
})

describe('projectRemoteStatus budgets', () => {
  it('truncates long titles and labels to the text budget by code point', () => {
    const long = '😀'.repeat(400)
    const status = projectRemoteStatus(
      snapshot([session('a', { workspace: `/x/${long}`, title: long })]),
      policy({ sharedWorkspaces: [`/x/${long}`, `/y/${long}`], shareTitles: true })
    )
    const max = REMOTE_STATUS_LIMITS.maxTextLength
    const labels = status.projects.map((project) => project.label)
    const titles = status.projects.flatMap((project) => project.sessions.map((row) => row.title))
    expect(titles).toHaveLength(1)
    for (const text of [...labels, ...titles]) {
      expect(Array.from(text).length).toBeLessThanOrEqual(max)
      expect(text).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/)
    }
    expect(new Set(labels).size).toBe(2)
    expect(labels.filter((label) => label.endsWith('… 2'))).toHaveLength(1)
  })

  it('keeps the newest rows within the row budget and counts the rest', () => {
    const extra = 7
    const sessions = Array.from({ length: REMOTE_STATUS_LIMITS.maxSessions + extra }, (_, i) =>
      session(`s${i}`, { minute: i })
    )
    const status = projectRemoteStatus(snapshot(sessions), policy())
    const rows = firstProject(status).sessions
    expect(rows).toHaveLength(REMOTE_STATUS_LIMITS.maxSessions)
    expect(status.omitted).toEqual({ projects: 0, sessions: extra })
    expect(rows[0]?.lastActivityAt).toBe((sessions.length - 1) * 60_000)
    expect(rows.at(-1)?.lastActivityAt).toBe(extra * 60_000)
  })

  it('keeps the first projects by label within the project budget and counts their sessions', () => {
    const count = REMOTE_STATUS_LIMITS.maxProjects + 2
    const folders = Array.from({ length: count }, (_, i) => `/w/p${String(i).padStart(3, '0')}`)
    const status = projectRemoteStatus(
      snapshot([session('last', { workspace: folders[count - 1] })]),
      policy({ sharedWorkspaces: [...folders].reverse() })
    )
    expect(status.projects).toHaveLength(REMOTE_STATUS_LIMITS.maxProjects)
    expect(firstProject(status).label).toBe('p000')
    expect(status.omitted).toEqual({ projects: 2, sessions: 1 })
  })

  it('gives the same output for the same input', () => {
    const sessions = [session('a', { minute: 1 }), session('b', { minute: 1 })]
    expect(projectRemoteStatus(snapshot(sessions), policy())).toEqual(
      projectRemoteStatus(snapshot([...sessions].reverse()), policy())
    )
  })
})

describe('projectRemoteStatus source eligibility (CONSTRAINT-004)', () => {
  const ANTIGRAVITY: AgentTool = 'antigravity'
  const AG_SENTINELS = {
    title: 'SENTINEL-AG-TITLE',
    rawId: 'SENTINEL-AG-RAW-ID',
    version: 'SENTINEL-AG-VERSION'
  }

  function mixedSnapshot(sessions: Session[], agHealth: ToolHealth): SessionsSnapshot {
    const base = snapshot(sessions)
    return {
      ...base,
      health: {
        ...base.health,
        antigravity: agHealth
      }
    }
  }

  function agSession(id: string, workspace: string | null, minute = 10): Session {
    return {
      key: { tool: ANTIGRAVITY, id: `${AG_SENTINELS.rawId}-${id}` },
      summary: {
        title: `${AG_SENTINELS.title} ${id}`,
        workspacePath: workspace,
        lastActivityAt: minute * 60_000,
        toolVersion: AG_SENTINELS.version
      },
      activity: { state: 'running' },
      attention: { waiting: false, newReply: true, error: false },
      lastReply: {
        cursor: 'SENTINEL-AG-CURSOR',
        completedAt: 1,
        isError: false,
        errorCode: null,
        newerTurnStarted: false
      },
      pinned: false
    }
  }

  it('projects only eligible rows in a mixed shared workspace without minting ineligible IDs or leaking health', () => {
    const spyMint = vi.fn(mintId)
    const app = `${SENTINELS.path}/app`
    const agOnly = `${SENTINELS.path}/ag-only`
    const mixed = mixedSnapshot(
      [
        session('cx', { tool: 'codex', workspace: app, minute: 2 }),
        session('cl', { tool: 'claude', workspace: app, minute: 3 }),
        agSession('mixed', app, 9),
        agSession('only', agOnly, 10)
      ],
      { state: 'connected', lastReadAt: 99 }
    )
    const status = projectRemoteStatus(
      mixed,
      policy({ sharedWorkspaces: [app, agOnly], shareTitles: false, mintId: spyMint })
    )

    expect(Object.keys(status.sources)).toEqual(['codex', 'claude'])
    expect(status.projects).toHaveLength(2)
    const agProject = status.projects.find((p) => p.label === 'ag-only')
    const appProject = status.projects.find((p) => p.label === 'app')
    expect(agProject?.sessions).toEqual([])
    expect(appProject?.sessions.map((row) => row.tool)).toEqual(['claude', 'codex'])
    expect(appProject?.sessions.map((row) => row.title).sort()).toEqual(['Session 1', 'Session 2'])
    expect(spyMint).toHaveBeenCalledTimes(2)
    expect(spyMint.mock.calls.every(([key]) => key.tool === 'codex' || key.tool === 'claude')).toBe(
      true
    )
    const text = JSON.stringify(status)
    expect(text).not.toContain('antigravity')
    expect(leaks(status, Object.values(AG_SENTINELS))).toEqual([])
  })

  it('does not leak ineligible titles with shareTitles on or count ineligible rows toward budgets', () => {
    const spyMint = vi.fn(mintId)
    const count = REMOTE_STATUS_LIMITS.maxProjects + 1
    const folders = Array.from({ length: count }, (_, i) => `/w/p${String(i).padStart(3, '0')}`)
    const eligible = Array.from({ length: REMOTE_STATUS_LIMITS.maxSessions }, (_, i) =>
      session(`e${i}`, { workspace: folders[0], minute: i })
    )
    const mixed = mixedSnapshot(
      [
        ...eligible,
        agSession('newest-in-shared', folders[0]!, REMOTE_STATUS_LIMITS.maxSessions + 50),
        agSession('in-omitted-project', folders[count - 1]!, 1)
      ],
      { state: 'no-access', lastReadAt: null }
    )
    const status = projectRemoteStatus(
      mixed,
      policy({ sharedWorkspaces: folders, shareTitles: true, mintId: spyMint })
    )
    expect(status.projects[0]?.sessions).toHaveLength(REMOTE_STATUS_LIMITS.maxSessions)
    expect(status.omitted).toEqual({ projects: 1, sessions: 0 })
    expect(spyMint).toHaveBeenCalledTimes(REMOTE_STATUS_LIMITS.maxSessions)
    expect(JSON.stringify(status)).not.toContain('antigravity')
    expect(leaks(status, Object.values(AG_SENTINELS))).toEqual([])
  })
})
