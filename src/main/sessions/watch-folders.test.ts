import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { FolderWatch } from './file-watcher'
import { sessionFolderWatches } from './watch-folders'

// Synthetic paths only: a made-up home folder that is never touched.
const HOME = '/Users/synthetic'
const ID = '00000000-0000-4000-8000-000000000001'
const CATALOG = join(HOME, 'Library', 'Application Support', 'Claude', 'claude-code-sessions')
const UPPER_ID = '0000000A-0000-4000-8000-00000000000B'
const BRAIN = join(HOME, '.gemini', 'antigravity', 'brain')
const ANNOTATIONS = join(HOME, '.gemini', 'antigravity', 'annotations')

const watches = sessionFolderWatches(HOME)

function watchOf(folder: string): FolderWatch {
  const watch = watches.find((candidate) => candidate.folder === folder)
  if (watch === undefined) throw new Error(`No watch on ${folder}.`)
  return watch
}

/** The folder watches whose filter accepts the path, as `<tool>:<folder>`. */
function acceptedBy(path: string): string[] {
  return watches
    .filter((watch) => watch.accepts(path))
    .map((watch) => `${watch.tool}:${watch.folder}`)
}

describe('sessionFolderWatches', () => {
  it('watches exactly the five folders decided in TASK-002 and the two Antigravity folders', () => {
    expect(watches.map(({ tool, folder, recursive }) => ({ tool, folder, recursive }))).toEqual([
      { tool: 'claude', folder: join(HOME, '.claude', 'sessions'), recursive: false },
      { tool: 'claude', folder: join(HOME, '.claude', 'projects'), recursive: true },
      { tool: 'claude', folder: CATALOG, recursive: true },
      { tool: 'codex', folder: join(HOME, '.codex'), recursive: false },
      { tool: 'codex', folder: join(HOME, '.codex', 'sessions'), recursive: true },
      { tool: 'antigravity', folder: BRAIN, recursive: true },
      { tool: 'antigravity', folder: ANNOTATIONS, recursive: false }
    ])
  })

  it('accepts Claude Code registry files, never their .key files', () => {
    const registry = watchOf(join(HOME, '.claude', 'sessions'))
    expect(acceptedBy(join(registry.folder, '4242.json'))).toEqual([`claude:${registry.folder}`])
    for (const name of ['4242.abcdef.key', 'abc.json', '4242.json.tmp', 'sub/4242.json']) {
      expect(acceptedBy(join(registry.folder, name))).toEqual([])
    }
  })

  it('accepts transcripts at the top of a project folder only', () => {
    const projects = watchOf(join(HOME, '.claude', 'projects'))
    expect(acceptedBy(join(projects.folder, '-Users-synthetic-demo', `${ID}.jsonl`))).toEqual([
      `claude:${projects.folder}`
    ])
    for (const name of [
      `${ID}.jsonl`,
      `-Users-synthetic-demo/${ID}/subagents/agent-1.jsonl`,
      `-Users-synthetic-demo/${ID}/tool-results/result.jsonl`,
      `.hidden/${ID}.jsonl`,
      `-Users-synthetic-demo/${ID}.json`
    ]) {
      expect(acceptedBy(join(projects.folder, name))).toEqual([])
    }
  })

  it('accepts catalog files two folders down, never their temporary files', () => {
    expect(acceptedBy(join(CATALOG, 'account', 'organization', 'local_1.json'))).toEqual([
      `claude:${CATALOG}`
    ])
    for (const name of [
      'account/organization/local_1.json.tmp',
      'account/local_1.json',
      'account/organization/other.json'
    ]) {
      expect(acceptedBy(join(CATALOG, name))).toEqual([])
    }
  })

  it('accepts only the index among Codex’s own files', () => {
    const codex = join(HOME, '.codex')
    expect(acceptedBy(join(codex, 'session_index.jsonl'))).toEqual([`codex:${codex}`])
    for (const name of ['.codex-global-state.json', 'state.sqlite-wal', 'auth.json']) {
      expect(acceptedBy(join(codex, name))).toEqual([])
    }
  })

  it('accepts rollouts in the sessions folder, never compressed ones', () => {
    const sessions = join(HOME, '.codex', 'sessions')
    expect(acceptedBy(join(sessions, '2026', '01', '15', `rollout-x-${ID}.jsonl`))).toEqual([
      `codex:${sessions}`
    ])
    for (const name of [`2026/01/15/rollout-x-${ID}.jsonl.zst`, '2026/01/15', '2026']) {
      expect(acceptedBy(join(sessions, name))).toEqual([])
    }
  })

  it('accepts Antigravity transcripts only, never the full transcript or other brain files', () => {
    const transcript = join(BRAIN, ID, '.system_generated', 'logs', 'transcript.jsonl')
    expect(acceptedBy(transcript)).toEqual([`antigravity:${BRAIN}`])
    for (const name of [
      `${ID}/.system_generated/logs/transcript_full.jsonl`,
      `${ID}/.system_generated/logs/transcript.jsonl.tmp`,
      `${ID}/.system_generated/transcript.jsonl`,
      `${ID}/task.md`,
      `${ID}.pb`,
      `tempmediaStorage/.system_generated/logs/transcript.jsonl`,
      `${UPPER_ID}/.system_generated/logs/transcript.jsonl`
    ]) {
      expect(acceptedBy(join(BRAIN, name)), name).toEqual([])
    }
    // A path with `..` parts, as an event name could hold, is refused before it is resolved.
    expect(acceptedBy(`${BRAIN}/${ID}/.system_generated/logs/../logs/transcript.jsonl`)).toEqual([])
  })

  it('accepts Antigravity title annotations only, never other files there', () => {
    expect(acceptedBy(join(ANNOTATIONS, `${ID}.pbtxt`))).toEqual([`antigravity:${ANNOTATIONS}`])
    for (const name of [
      `${ID}.pbtxt.tmp`,
      `.${ID}.pbtxt`,
      `${UPPER_ID}.pbtxt`,
      'oauth_creds.json',
      `sub/${ID}.pbtxt`
    ]) {
      expect(acceptedBy(join(ANNOTATIONS, name)), name).toEqual([])
    }
    // The Gemini CLI's own folder is never watched.
    expect(acceptedBy(join(HOME, '.gemini', 'oauth_creds.json'))).toEqual([])
  })
})
