import { lstat, mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  CWD,
  PROJECT,
  IDS,
  PIDS,
  HOSTILE,
  LONG_REPLY,
  id,
  meta,
  started,
  complete,
  codexMessage,
  tokenCount,
  toolCall,
  toolDetailCalls,
  index,
  prompt,
  assistant,
  claudeToolDetailCalls,
  registry
} from './records.mjs'

const MARKER = '.agentpeek-synthetic.json'
const MARKER_TEXT = JSON.stringify({ kind: 'agentpeek-task-014-synthetic', version: 1 })
export const codexPath = (home, sessionId) =>
  join(home, '.codex/sessions/2026/01/15', `rollout-2026-01-15T09-00-00-${sessionId}.jsonl`)
export const transcriptPath = (home, sessionId) =>
  join(home, '.claude/projects', PROJECT, `${sessionId}.jsonl`)
export const registryPath = (home, name) => join(home, '.claude/sessions', `${PIDS[name]}.json`)

export async function writeLines(path, lines, at) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, lines.join('\n') + '\n', { flag: 'wx' })
  await utimes(path, at / 1000, at / 1000)
}

/** Never accepts an output path. Only creates a new owned directory under the OS temp folder. */
export async function createFixture({ now = Date.now(), missingTool } = {}) {
  if (!Number.isSafeInteger(now) || ![undefined, 'codex', 'claude'].includes(missingTool))
    throw new Error('Invalid fixture options.')
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agentpeek-fixture-')))
  const home = join(root, 'home')
  const userData = join(root, 'user-data')
  try {
    await mkdir(home)
    await mkdir(userData)
    await writeFile(join(home, MARKER), MARKER_TEXT, { flag: 'wx' })
    if (missingTool !== 'codex') await createCodex(home, now)
    if (missingTool !== 'claude') await createClaude(home, now)
    return { root, home, userData }
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

async function createCodex(home, now) {
  for (const [name, body] of [
    [
      'synthetic-recorded',
      '# Synthetic current recorded file\nThis differs from the conversation copy.'
    ],
    [
      'synthetic-local',
      '---\nname: synthetic-local\ndescription: Synthetic current local skill.\n---\n# Synthetic local skill\n\nCurrent local instructions.'
    ],
    ['synthetic-long', '# Synthetic long skill\n\n' + 'x'.repeat(70_000)],
    ['synthetic-empty', '']
  ])
    await writeLines(join(home, '.agents', 'skills', name, 'SKILL.md'), [body], now)
  await mkdir(join(home, '.agents', 'skills', 'synthetic-missing'), { recursive: true })
  await writeLines(join(home, 'synthetic-other', 'SKILL.md'), ['# Synthetic blocked file'], now)
  const titles = []
  for (const name of [
    'complete',
    'error',
    'aborted',
    'long',
    'hostile',
    'retry',
    'malformed',
    'old'
  ]) {
    const sessionId = IDS[name]
    const at = name === 'old' ? now - 9 * 86400000 : now - 60000
    const lines = [
      meta(sessionId, at),
      started(id(1000 + Object.keys(IDS).indexOf(name)), at + 1),
      codexMessage('Synthetic user prompt.', at + 2, 'UserMessage')
    ]
    // The newest usage figures, 5-hour 16% and weekly 43%; an older thread recorded lower ones.
    if (name === 'complete') lines.push(tokenCount(at + 3, 16, 43))
    if (name === 'error') lines.push(tokenCount(at + 2, 9, 40))
    if (['long', 'hostile', 'retry'].includes(name)) {
      if (name === 'long') {
        for (let i = 0; i < 24; i++)
          lines.push(codexMessage(`Synthetic earlier reply ${i}.`, at + 3 + i))
        lines.push(codexMessage('Synthetic latest prompt.', at + 28, 'UserMessage'))
      }
      lines.push(
        ...(name === 'retry' ? toolDetailCalls(at + 29) : [toolCall(at + 29)]),
        codexMessage(
          name === 'long' ? LONG_REPLY : name === 'hostile' ? HOSTILE : 'Synthetic retry reply.',
          at + 30
        ),
        complete(id(1000 + Object.keys(IDS).indexOf(name)), at + 31)
      )
    }
    if (name === 'malformed') lines.push('{synthetic malformed line', complete(id(1006), at + 31))
    if (name === 'old') lines.push(complete(id(1007), at + 31))
    await writeLines(codexPath(home, sessionId), lines, at + 31)
    titles.push(
      index(
        sessionId,
        `Fixture Codex ${name}${name === 'long' ? ' — synthetic long title'.repeat(12) : ''}`,
        at
      )
    )
  }
  for (let i = 0; i < 55; i++) {
    const at = now - 600000 - i * 1000
    const sessionId = id(200 + i)
    await writeLines(
      codexPath(home, sessionId),
      [meta(sessionId, at), started(id(2000 + i), at), complete(id(2000 + i), at + 1)],
      at + 1
    )
    titles.push(index(sessionId, `Fixture Codex bulk ${i + 1}`, at))
  }
  await writeLines(join(home, '.codex/session_index.jsonl'), titles, now - 1000)
}

async function createClaude(home, now) {
  for (const [i, name] of ['busy', 'stopped', 'apiError', 'dead'].entries()) {
    const at = now - 60000 - i * 1000
    const calls = name === 'busy' ? claudeToolDetailCalls(IDS[name], at + 1) : []
    await writeLines(transcriptPath(home, IDS[name]), [prompt(IDS[name], at), ...calls], at)
    await writeLines(registryPath(home, name), [registry(name, 'busy', at)], at)
    await catalog(home, IDS[name], `Fixture Claude ${name}`, at)
  }
  for (let i = 0; i < 55; i++) {
    const sessionId = id(500 + i)
    const at = now - 600000 - i * 1000
    await writeLines(
      transcriptPath(home, sessionId),
      [prompt(sessionId, at), assistant(sessionId, at + 1)],
      at + 1
    )
    await catalog(home, sessionId, `Fixture Claude bulk ${i + 1}`, at + 1)
  }
}

async function catalog(home, sessionId, title, at) {
  await writeLines(
    join(
      home,
      'Library/Application Support/Claude/claude-code-sessions/synthetic-account/synthetic-org',
      `local_${sessionId}.json`
    ),
    [
      JSON.stringify({
        cliSessionId: sessionId,
        title,
        cwd: CWD,
        isArchived: false,
        createdAt: at,
        lastActivityAt: at
      })
    ],
    at
  )
}

/** Simulator writes require our marker, an OS-temp home, and no symlinks in the target path. */
export async function fixtureTarget(home, path = home) {
  const temporary = await realpath(tmpdir())
  if (
    !isAbsolute(home) ||
    resolve(home) !== home ||
    !home.startsWith(temporary + sep) ||
    resolve(path) !== path
  )
    throw new Error('Expected an absolute synthetic home under the OS temp folder.')
  const inside = relative(home, path)
  if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside))
    throw new Error('Target is outside the fixture.')
  let current = temporary
  for (const part of relative(temporary, path).split(sep)) {
    current = join(current, part)
    const stats = await lstat(current)
    if (stats.isSymbolicLink()) throw new Error('Fixture paths must not contain symlinks.')
  }
  const marker = join(home, MARKER)
  if (!(await lstat(marker)).isFile() || (await readFile(marker, 'utf8')) !== MARKER_TEXT)
    throw new Error('Synthetic fixture marker missing.')
  return path
}

export async function removeFixture(home) {
  await fixtureTarget(home)
  const root = dirname(home)
  if (basename(home) !== 'home' || !basename(root).startsWith('agentpeek-fixture-'))
    throw new Error(
      'Not a generated fixture root; use the verification helper to clean copied runs.'
    )
  await rm(root, { recursive: true, force: true })
}
