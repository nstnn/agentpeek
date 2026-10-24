import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, open, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AccessRefusedError,
  createAccessGate,
  createSkillAccessGate,
  type RefusalReason
} from './access'

// Spy on the real `open` and `realpath`, to prove that a refused path is never opened.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, open: vi.fn(actual.open), realpath: vi.fn(actual.realpath) }
})

// Every file here is synthetic, in a temporary folder that stands in for the home folder.
let root: string
let home: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agentpeek-access-'))
  home = join(root, 'home')
  await mkdir(home)
  vi.mocked(open).mockClear()
  vi.mocked(realpath).mockClear()
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function createFile(path: string, content = '{"type":"synthetic"}\n'): Promise<string> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
  return path
}

function homePath(...names: string[]): string {
  return join(home, ...names)
}

async function expectRefused(path: string, reason: RefusalReason): Promise<void> {
  const gate = createAccessGate(home)
  const refused = { name: 'AccessRefusedError', reason }
  await expect(gate.resolve(path)).rejects.toMatchObject(refused)
  await expect(gate.open(path)).rejects.toMatchObject(refused)
  expect(open).not.toHaveBeenCalled()
}

const ALLOWED_FILES = [
  ['the Codex index', ['.codex', 'session_index.jsonl']],
  ['a Codex rollout', ['.codex', 'sessions', '2026', '01', '15', 'rollout-2026-01-15-t1.jsonl']],
  ['a Claude Code registry file', ['.claude', 'sessions', '12345.json']],
  ['a Claude Code transcript', ['.claude', 'projects', '-synthetic-project', 'session-1.jsonl']],
  [
    'a Claude Desktop catalog file',
    [
      'Library',
      'Application Support',
      'Claude',
      'claude-code-sessions',
      'org-1',
      'account-1',
      'local_session-1.json'
    ]
  ]
] as const

describe('createAccessGate', () => {
  it('opens only SKILL.md in approved user/plugin/project skill roots, separately from tool reads', async () => {
    const workspace = join(root, 'project')
    for (const path of [
      homePath('.agents', 'skills', 'pr', 'SKILL.md'),
      homePath('.codex', 'skills', '.system', 'imagegen', 'SKILL.md'),
      homePath('.codex', 'plugins', 'cache', 'example', '1.0', 'skills', 'pr', 'SKILL.md'),
      join(workspace, '.agents', 'skills', 'pr', 'SKILL.md')
    ]) {
      await createFile(path, '# Synthetic skill')
      await expect(createAccessGate(home).open(path)).rejects.toMatchObject({
        reason: 'not-allowed'
      })
      const handle = await createSkillAccessGate(home, workspace, false).open(path)
      try {
        await expect(handle.writeFile('modified')).rejects.toMatchObject({ code: 'EBADF' })
      } finally {
        await handle.close()
      }
    }
  })
  it('refuses arbitrary files, symlink escapes and fixture reads outside the synthetic home', async () => {
    const workspace = join(root, 'project')
    const projectSkill = await createFile(join(workspace, '.agents', 'skills', 'pr', 'SKILL.md'))
    const escaped = homePath('.agents', 'skills', 'escape', 'SKILL.md')
    await mkdir(dirname(escaped), { recursive: true })
    await symlink(projectSkill, escaped)
    const gate = createSkillAccessGate(home, workspace, true)
    await expect(gate.open(projectSkill)).rejects.toMatchObject({ reason: 'not-allowed' })
    await expect(gate.open(escaped)).rejects.toMatchObject({ reason: 'symlink-escape' })
    for (const path of [
      homePath('SKILL.md'),
      homePath('.agents', 'skills', 'pr', 'auth.json'),
      homePath('.agents', 'skills', 'pr', 'secret.key')
    ]) {
      vi.mocked(open).mockClear()
      await expect(gate.open(path)).rejects.toBeInstanceOf(AccessRefusedError)
      expect(open).not.toHaveBeenCalled()
    }
  })
  it('rejects a synthetic skill-root symlink to a real external tree before opening content', async () => {
    const external = join(root, 'external-skills')
    const path = await createFile(join(external, 'pr', 'SKILL.md'))
    await mkdir(homePath('.agents'), { recursive: true })
    await symlink(external, homePath('.agents', 'skills'))
    const alias = homePath('.agents', 'skills', 'pr', 'SKILL.md')
    vi.mocked(open).mockClear()
    await expect(createSkillAccessGate(home, null, true).open(alias)).rejects.toMatchObject({
      reason: 'symlink-escape'
    })
    expect(open).not.toHaveBeenCalled()
    const handle = await createSkillAccessGate(home, null, false).open(alias)
    await handle.close()
    expect(path).toContain('external-skills')
  })
  it.each(ALLOWED_FILES)('allows %s and opens it read-only', async (_, names) => {
    const path = await createFile(homePath(...names))
    const gate = createAccessGate(home)

    // The temporary folder itself sits behind a symlink on macOS (/var -> /private/var).
    expect(await gate.resolve(path)).toBe(await realpath(path))
    const handle = await gate.open(path)
    try {
      await expect(handle.writeFile('changed')).rejects.toMatchObject({ code: 'EBADF' })
    } finally {
      await handle.close()
    }
  })

  it('allows a Codex rollout at any folder depth under sessions', async () => {
    const path = await createFile(homePath('.codex', 'sessions', 'rollout-t1.jsonl'))
    await expect(createAccessGate(home).resolve(path)).resolves.toBe(await realpath(path))
  })

  it('reports a missing allowed file as ENOENT, not as a refusal', async () => {
    await mkdir(homePath('.claude', 'projects', '-synthetic-project'), { recursive: true })
    const path = homePath('.claude', 'projects', '-synthetic-project', 'missing.jsonl')
    await expect(createAccessGate(home).open(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses .key files before touching the disk, even when they exist', async () => {
    const path = await createFile(homePath('.claude', 'sessions', '12345.abcdef.key'), 'secret')
    await expectRefused(path, 'credential')
    await expectRefused(homePath('.claude', 'sessions', '12345.json.KEY'), 'credential')
    expect(realpath).not.toHaveBeenCalled()
  })

  it('refuses auth.json and credential files, also where a pattern would match them', async () => {
    await createFile(homePath('.claude', 'sessions', 'auth.json'), '{}')
    await expectRefused(homePath('.codex', 'auth.json'), 'credential')
    await expectRefused(homePath('.claude', 'sessions', 'auth.json'), 'credential')
    await expectRefused(homePath('.claude', 'sessions', 'AUTH.JSON'), 'credential')
    await expectRefused(homePath('.claude', 'sessions', 'credentials.json'), 'credential')
    await expectRefused(homePath('.claude', '.credentials.json'), 'credential')
    expect(realpath).not.toHaveBeenCalled()
  })

  it('refuses relative paths and paths with . or .. parts', async () => {
    const transcript = join('.claude', 'projects', '-synthetic-project', 'session-1.jsonl')
    await createFile(homePath(transcript))
    await expectRefused(transcript, 'not-normalized')
    await expectRefused(
      `${home}/.claude/projects/-synthetic-project/../../../secret.jsonl`,
      'not-normalized'
    )
    await expectRefused(
      `${home}/.claude/projects/./-synthetic-project/session-1.jsonl`,
      'not-normalized'
    )
    await expectRefused(
      `${home}//.claude/projects/-synthetic-project/session-1.jsonl`,
      'not-normalized'
    )
    expect(realpath).not.toHaveBeenCalled()
  })

  it.each([
    ['a file outside the tool folders', ['notes.jsonl']],
    ['the Codex config', ['.codex', 'config.toml']],
    ['another file in ~/.codex', ['.codex', '.codex-global-state.json']],
    ['a Codex file that is not a rollout', ['.codex', 'sessions', '2026', 'other.jsonl']],
    ['a hidden Codex folder', ['.codex', 'sessions', '.hidden', 'rollout-t1.jsonl']],
    ['a registry file in a subfolder', ['.claude', 'sessions', 'nested', '12345.json']],
    ['a hidden registry file', ['.claude', 'sessions', '.12345.json']],
    ['a transcript at the projects root', ['.claude', 'projects', 'session-1.jsonl']],
    ['a subagent transcript', ['.claude', 'projects', '-p', 'session-1', 'subagents', 'a.jsonl']],
    ['a tool result', ['.claude', 'projects', '-p', 'session-1', 'tool-results', 'r.jsonl']],
    ['Claude settings', ['.claude', 'settings.json']],
    [
      'a catalog file at the wrong depth',
      ['Library', 'Application Support', 'Claude', 'claude-code-sessions', 'org-1', 'local_1.json']
    ],
    [
      'a catalog temporary file',
      [
        'Library',
        'Application Support',
        'Claude',
        'claude-code-sessions',
        'org-1',
        'account-1',
        'local_1.json.tmp'
      ]
    ]
  ])('refuses %s', async (_, names) => {
    const path = await createFile(homePath(...names))
    await expectRefused(path, 'not-allowed')
    expect(realpath).not.toHaveBeenCalled()
  })

  it('refuses a file that only looks allowed under a different home folder', async () => {
    const path = await createFile(join(root, 'other-home', '.claude', 'sessions', '12345.json'))
    await expectRefused(path, 'not-allowed')
  })

  it('refuses a symlinked file that leads outside the allowlist, without opening it', async () => {
    const secret = await createFile(join(root, 'secret.txt'), 'secret')
    const link = homePath('.claude', 'projects', '-synthetic-project', 'session-1.jsonl')
    await mkdir(dirname(link), { recursive: true })
    await symlink(secret, link)
    await expectRefused(link, 'symlink-escape')
  })

  it('refuses a symlink to a key file next to it', async () => {
    const key = await createFile(homePath('.claude', 'sessions', '12345.abcdef.key'), 'secret')
    const link = homePath('.claude', 'sessions', '12345.json')
    await symlink(key, link)
    await expectRefused(link, 'symlink-escape')
  })

  it('refuses a symlinked project folder that leads outside the tool folder', async () => {
    await createFile(join(root, 'elsewhere', 'session-1.jsonl'))
    await mkdir(homePath('.claude', 'projects'), { recursive: true })
    await symlink(join(root, 'elsewhere'), homePath('.claude', 'projects', '-synthetic-project'))
    await expectRefused(
      homePath('.claude', 'projects', '-synthetic-project', 'session-1.jsonl'),
      'symlink-escape'
    )
  })

  it('allows a symlink that stays inside the allowlist', async () => {
    const target = await createFile(
      homePath('.claude', 'projects', '-project-a', 'session-1.jsonl')
    )
    const link = homePath('.claude', 'projects', '-project-b', 'session-1.jsonl')
    await mkdir(dirname(link), { recursive: true })
    await symlink(target, link)
    await expect(createAccessGate(home).resolve(link)).resolves.toBe(await realpath(target))
  })

  it('follows a tool folder that is itself a symlink, and checks the files inside it', async () => {
    const realFolder = join(root, 'dotfiles', 'claude')
    await createFile(join(realFolder, 'sessions', '12345.json'))
    await createFile(join(realFolder, 'sessions', '12345.abcdef.key'), 'secret')
    await symlink(realFolder, homePath('.claude'))
    const gate = createAccessGate(home)

    await expect(gate.resolve(homePath('.claude', 'sessions', '12345.json'))).resolves.toBe(
      await realpath(join(realFolder, 'sessions', '12345.json'))
    )
    await expectRefused(homePath('.claude', 'sessions', '12345.abcdef.key'), 'credential')
  })

  it('refuses a folder with an allowed name after opening it', async () => {
    const path = homePath('.claude', 'projects', '-synthetic-project', 'session-1.jsonl')
    await mkdir(path, { recursive: true })
    await expect(createAccessGate(home).open(path)).rejects.toMatchObject({ reason: 'not-a-file' })
  })

  it('refuses a named pipe without waiting for a writer', async () => {
    const path = homePath('.claude', 'projects', '-synthetic-project', 'session-1.jsonl')
    await mkdir(dirname(path), { recursive: true })
    execFileSync('/usr/bin/mkfifo', [path])
    await expect(createAccessGate(home).open(path)).rejects.toMatchObject({ reason: 'not-a-file' })
  })

  it('requires an absolute home folder', () => {
    expect(() => createAccessGate('relative/home')).toThrow('absolute')
  })

  it('keeps the path out of the error message', async () => {
    const error = await createAccessGate(home)
      .resolve(homePath('.codex', 'auth.json'))
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(AccessRefusedError)
    expect((error as Error).message).not.toContain(home)
  })
})
