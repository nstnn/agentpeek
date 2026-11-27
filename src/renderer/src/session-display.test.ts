import { describe, expect, it } from 'vitest'
import {
  openToolLabel,
  quietMinutes,
  relativeTime,
  rowStatus,
  sessionTitle,
  toolAuthor,
  toolMonogram,
  toolName,
  workspaceName
} from './session-display'
import { NOW, session } from '../test-support'

describe('session presentation', () => {
  it('uses distinct labels, authors, monograms, open support, and quiet limits for every tool', () => {
    expect([toolName('codex'), toolName('claude'), toolName('antigravity')]).toEqual([
      'Codex',
      'Claude Code',
      'Antigravity'
    ])
    expect([toolAuthor('codex'), toolAuthor('claude'), toolAuthor('antigravity')]).toEqual([
      'Codex',
      'Claude',
      'Antigravity'
    ])
    expect([toolMonogram('codex'), toolMonogram('claude'), toolMonogram('antigravity')]).toEqual([
      'C',
      'A',
      'G'
    ])
    expect([openToolLabel('codex'), openToolLabel('claude'), openToolLabel('antigravity')]).toEqual(
      ['Open Codex', 'Open Claude', 'Open Antigravity']
    )
    expect([quietMinutes('codex'), quietMinutes('antigravity')]).toEqual([30, 15])
    expect(
      rowStatus(
        session('ag-quiet', {
          key: { tool: 'antigravity', id: 'ag-quiet' },
          activity: { state: 'unknown', reason: 'quiet' }
        })
      ).label
    ).toBe('Unknown · Quiet for 15 min')
    expect(
      rowStatus(
        session('ag-unconfirmed', {
          key: { tool: 'antigravity', id: 'ag-unconfirmed' },
          activity: { state: 'unknown', reason: 'app-not-running' }
        })
      ).label
    ).toBe('Unknown · Antigravity activity unconfirmed')
    expect(
      rowStatus(session('cx-quiet', { activity: { state: 'unknown', reason: 'quiet' } })).label
    ).toBe('Unknown · Quiet for 30 min')
  })
  it('uses ID and folder fallbacks and preserves full source values', () => {
    const s = session('abcdef123', {
      summary: { title: null, workspacePath: null, lastActivityAt: NOW, toolVersion: null }
    })
    expect(sessionTitle(s)).toBe('Untitled session · abcdef')
    expect(workspaceName(s)).toBe('No folder')
    expect(
      workspaceName({ ...s, summary: { ...s.summary, workspacePath: '/synthetic/long path/' } })
    ).toBe('long path')
  })
  it('formats every relative-time range including yesterday and future clock skew', () => {
    expect(relativeTime(NOW + 60_000, NOW)).toBe('now')
    expect(relativeTime(NOW - 59_999, NOW)).toBe('now')
    expect(relativeTime(NOW - 5 * 60_000, NOW)).toBe('5 min')
    expect(relativeTime(NOW - 2 * 3_600_000, NOW)).toBe('2 h')
    expect(relativeTime(NOW - 24 * 3_600_000, NOW)).toBe('Yesterday')
    expect(relativeTime(NOW - 3 * 24 * 3_600_000, NOW)).toBe('Thu')
    expect(relativeTime(NOW - 10 * 24 * 3_600_000, NOW)).toBe('Oct 8')
  })
})
