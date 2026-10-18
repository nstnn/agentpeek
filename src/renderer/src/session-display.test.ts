import { describe, expect, it } from 'vitest'
import { relativeTime, sessionTitle, workspaceName } from './session-display'
import { NOW, session } from '../test-support'

describe('session presentation', () => {
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
