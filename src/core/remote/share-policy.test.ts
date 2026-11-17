import { describe, expect, it } from 'vitest'
import type { Session } from '../session'
import { createSnapshot, type SessionsSnapshot } from '../snapshot'
import {
  isListedWorkspace,
  isShareableWorkspace,
  narrowsSharing,
  normalizeWorkspace,
  sourceTurnedOff,
  type RemoteSharing
} from './share-policy'

// Synthetic folders only.
const APP = '/Users/synthetic/projects/app'

function snapshot(workspaces: (string | null)[], codex: 'connected' | 'off' = 'connected') {
  const sessions: Session[] = workspaces.map((workspacePath, index) => ({
    key: { tool: 'codex', id: `synthetic-${index}` },
    summary: { title: null, workspacePath, lastActivityAt: index, toolVersion: null },
    activity: { state: 'idle' },
    attention: { waiting: false, newReply: false, error: false },
    lastReply: null,
    pinned: false
  }))
  return createSnapshot({
    sessions,
    health: {
      codex: codex === 'off' ? { state: 'off' } : { state: 'connected', lastReadAt: 1 },
      claude: { state: 'not-installed' }
    },
    localState: { kind: 'available' },
    firstLaunch: false,
    fixture: true,
    takenAt: 1
  })
}

const sharing = (sharedWorkspaces: string[], shareTitles = false): RemoteSharing => ({
  sharedWorkspaces,
  shareTitles
})

describe('shareable workspaces', () => {
  it('accepts an absolute folder in exact-match form only', () => {
    expect(isShareableWorkspace(APP)).toBe(true)
    expect(isShareableWorkspace('/Users/synthetic/My Projects/émoji ✓')).toBe(true)
    for (const value of [
      `${APP}/`,
      'projects/app',
      '/',
      '',
      `${APP}\n`,
      `/Users/synthetic/a\u0007b`,
      `/${'x'.repeat(1024)}`,
      null,
      7,
      [APP]
    ]) {
      expect(isShareableWorkspace(value), String(value)).toBe(false)
    }
    expect(isShareableWorkspace(`/${'x'.repeat(1023)}`)).toBe(true)
    // PATH_MAX counts bytes: 512 two-byte characters plus the slash are over it.
    expect(isShareableWorkspace(`/${'é'.repeat(512)}`)).toBe(false)
  })

  it('normalizes only trailing slashes', () => {
    expect(normalizeWorkspace(`${APP}//`)).toBe(APP)
    expect(normalizeWorkspace('/')).toBeNull()
    expect(normalizeWorkspace('relative/app')).toBeNull()
    expect(normalizeWorkspace(null)).toBeNull()
  })

  it('lists only the exact folders of listed sessions, never their children or parents', () => {
    const listed = snapshot([`${APP}/`, null, '/Users/synthetic/projects/other/packages/web'])
    expect(isListedWorkspace(listed, APP)).toBe(true)
    expect(isListedWorkspace(listed, '/Users/synthetic/projects/other')).toBe(false)
    expect(isListedWorkspace(listed, `${APP}/packages`)).toBe(false)
    expect(isListedWorkspace(snapshot([]), APP)).toBe(false)
  })
})

describe('policy narrowing', () => {
  it('is a removed folder or titles turned off, never an addition or titles turned on', () => {
    const other = '/Users/synthetic/projects/other'
    expect(narrowsSharing(sharing([APP, other]), sharing([other]))).toBe(true)
    expect(narrowsSharing(sharing([APP], true), sharing([APP], false))).toBe(true)
    expect(narrowsSharing(sharing([APP]), sharing([other]))).toBe(true)
    expect(narrowsSharing(sharing([APP]), sharing([APP, other]))).toBe(false)
    expect(narrowsSharing(sharing([APP]), sharing([APP], true))).toBe(false)
    expect(narrowsSharing(sharing([APP, other]), sharing([other, APP]))).toBe(false)
  })

  it('notices a source turned off, not one turned on or staying off', () => {
    const on: SessionsSnapshot = snapshot([APP])
    const off: SessionsSnapshot = snapshot([], 'off')
    expect(sourceTurnedOff(on, off)).toBe(true)
    expect(sourceTurnedOff(off, on)).toBe(false)
    expect(sourceTurnedOff(off, off)).toBe(false)
    expect(sourceTurnedOff(on, on)).toBe(false)
  })
})
