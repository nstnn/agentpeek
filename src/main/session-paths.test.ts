import { describe, expect, it } from 'vitest'
import { resolveSessionPaths } from './session-paths'

describe('session paths', () => {
  it('uses the normal home and Electron userData without overrides', () => {
    expect(resolveSessionPaths({}, '/normal/home', '/normal/state')).toEqual({
      home: '/normal/home',
      stateFolder: '/normal/state',
      fixture: false
    })
  })
  it('uses both fixture paths together', () => {
    expect(
      resolveSessionPaths(
        { AGENTPEEK_HOME: '/fake/home', AGENTPEEK_USER_DATA: '/fake/state' },
        '/real/home',
        '/real/state'
      )
    ).toEqual({ home: '/fake/home', stateFolder: '/fake/state', fixture: true })
  })
  it.each([
    { AGENTPEEK_HOME: '/fake/home' },
    { AGENTPEEK_USER_DATA: '/fake/state' },
    { AGENTPEEK_HOME: '', AGENTPEEK_USER_DATA: '/fake/state' },
    { AGENTPEEK_HOME: 'relative', AGENTPEEK_USER_DATA: '/fake/state' },
    { AGENTPEEK_HOME: '/fake/home', AGENTPEEK_USER_DATA: 'relative' }
  ])(
    'rejects incomplete or relative fixture overrides without falling back to real data: %j',
    (env) => {
      expect(() => resolveSessionPaths(env, '/real/home', '/real/state')).toThrow(
        'both overrides as absolute paths'
      )
    }
  )
})
