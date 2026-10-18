import { isAbsolute } from 'node:path'

export interface SessionPaths {
  home: string
  stateFolder: string
  fixture: boolean
}

/** Fixture mode fails closed: neither reads nor state writes may fall back to real data. */
export function resolveSessionPaths(
  env: Record<string, string | undefined>,
  home: string,
  stateFolder: string
): SessionPaths {
  const fixtureHome = env['AGENTPEEK_HOME']
  const fixtureState = env['AGENTPEEK_USER_DATA']
  if (fixtureHome === undefined && fixtureState === undefined) {
    return { home, stateFolder, fixture: false }
  }
  if (!fixtureHome || !fixtureState || !isAbsolute(fixtureHome) || !isAbsolute(fixtureState)) {
    throw new Error('Fixture mode requires both overrides as absolute paths.')
  }
  return { home: fixtureHome, stateFolder: fixtureState, fixture: true }
}
