import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { codexPaths, isRolloutPath, sweepRollouts } from './codex-files'

// Synthetic files only, in a temporary folder that stands in for the home folder.
let root: string
let home: string
let sessions: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agentpeek-codex-files-'))
  home = join(root, 'home')
  sessions = codexPaths(home).sessions
  await mkdir(sessions, { recursive: true })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function createFile(path: string, modifiedAt?: number): Promise<string> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, '{}\n')
  if (modifiedAt !== undefined) await utimes(path, modifiedAt / 1000, modifiedAt / 1000)
  return path
}

const ROLLOUT = 'rollout-2026-01-15T09-00-00-00000000-0000-4000-8000-000000000001.jsonl'

describe('codexPaths', () => {
  it('builds the index and sessions paths from the home folder', () => {
    expect(codexPaths('/Users/synthetic')).toEqual({
      index: '/Users/synthetic/.codex/session_index.jsonl',
      sessions: '/Users/synthetic/.codex/sessions'
    })
  })
})

describe('sweepRollouts', () => {
  it('lists rollouts in day folders with their modification times', async () => {
    const modifiedAt = Date.UTC(2026, 0, 15, 9, 30)
    const path = await createFile(join(sessions, '2026', '01', '15', ROLLOUT), modifiedAt)
    expect(await sweepRollouts(sessions)).toEqual([{ path, modifiedAt }])
  })

  it('skips compressed rollouts, hidden files, and other names', async () => {
    const day = join(sessions, '2026', '01', '15')
    await createFile(join(day, `${ROLLOUT}.zst`))
    await createFile(join(day, `.${ROLLOUT}`))
    await createFile(join(day, 'rollout-draft.json'))
    await createFile(join(day, 'notes.jsonl'))
    await createFile(join(sessions, '.hidden', '01', '15', ROLLOUT))
    expect(await sweepRollouts(sessions)).toEqual([])
  })

  it('allows one folder level more than YYYY/MM/DD, and no more', async () => {
    const four = await createFile(join(sessions, 'a', 'b', 'c', 'd', ROLLOUT))
    await createFile(join(sessions, 'a', 'b', 'c', 'd', 'e', ROLLOUT))
    expect((await sweepRollouts(sessions)).map((file) => file.path)).toEqual([four])
  })

  it('never follows a symlinked folder or file', async () => {
    const outside = join(root, 'outside')
    const target = await createFile(join(outside, ROLLOUT))
    await mkdir(join(sessions, '2026', '01'), { recursive: true })
    await symlink(outside, join(sessions, '2026', '01', '15'))
    await mkdir(join(sessions, '2026', '02', '01'), { recursive: true })
    await symlink(target, join(sessions, '2026', '02', '01', ROLLOUT))
    expect(await sweepRollouts(sessions)).toEqual([])
  })

  it('passes errors on the sessions folder itself to the caller', async () => {
    await expect(sweepRollouts(join(root, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' })
    const file = await createFile(join(root, 'not-a-folder'))
    await expect(sweepRollouts(file)).rejects.toMatchObject({ code: 'ENOTDIR' })
  })
})

describe('isRolloutPath', () => {
  const paths = codexPaths('/Users/synthetic')

  it('accepts a rollout under the sessions folder', () => {
    expect(isRolloutPath(paths, `/Users/synthetic/.codex/sessions/2026/01/15/${ROLLOUT}`)).toBe(
      true
    )
  })

  it.each([
    ['a compressed rollout', `/Users/synthetic/.codex/sessions/2026/01/15/${ROLLOUT}.zst`],
    ['the index', '/Users/synthetic/.codex/session_index.jsonl'],
    ['a rollout outside the sessions folder', `/Users/synthetic/.codex/${ROLLOUT}`],
    ['a path that leaves the folder', `/Users/synthetic/.codex/sessions/../${ROLLOUT}`],
    ['the sessions folder', '/Users/synthetic/.codex/sessions'],
    ['a day folder', '/Users/synthetic/.codex/sessions/2026/01/15']
  ])('rejects %s', (_name, path) => {
    expect(isRolloutPath(paths, path)).toBe(false)
  })
})
