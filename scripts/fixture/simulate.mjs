import { appendFile, chmod, mkdir, rename, rm, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fixtureTarget, codexPath, registryPath, transcriptPath } from './home.mjs'
import {
  IDS,
  id,
  started,
  complete,
  codexEvent,
  codexMessage,
  prompt,
  assistant,
  claude,
  registry,
  CWD,
  ANTIGRAVITY_IDS,
  antigravityPrompt,
  antigravityToolRequest,
  antigravityToolResult,
  antigravityReply,
  antigravitySkillBlock,
  antigravityTitle
} from './records.mjs'

export const STEPS = Object.freeze([
  'codex-complete',
  'codex-error',
  'codex-aborted',
  'codex-reply',
  'codex-new-turn',
  'claude-waiting',
  'claude-denied',
  'claude-stopped',
  'claude-api-error',
  'claude-reply',
  'claude-new-turn',
  'registry-removed',
  'old-resumed',
  'malformed-line',
  'read-failure',
  'read-restored',
  'missing-codex',
  'restore-codex',
  'skill-references',
  'claude-skill',
  'skill-local-updated',
  'skill-missing-restored',
  'antigravity-seed',
  'antigravity-skill'
])

const MINUTE = 60 * 1000

/** Creates one new folder inside the fixture. Never reuses or follows an existing entry. */
async function newFolder(home, parent, name) {
  const path = join(await fixtureTarget(home, parent), name)
  await mkdir(path)
  return fixtureTarget(home, path)
}

/** Writes one Antigravity conversation: its transcript (mtime at the last step) and its title. */
async function writeAntigravityConversation(home, name, start, records) {
  const root = await fixtureTarget(home, join(home, '.gemini', 'antigravity'))
  const conversationId = ANTIGRAVITY_IDS[name]
  let folder = await fixtureTarget(home, join(root, 'brain'))
  for (const part of [conversationId, '.system_generated', 'logs'])
    folder = await newFolder(home, folder, part)
  const transcript = join(folder, 'transcript.jsonl')
  await writeFile(transcript, records.join('\n') + '\n', { flag: 'wx' })
  const last = (start + (records.length - 1) * 1000) / 1000
  await utimes(transcript, last, last)
  await writeFile(
    join(root, 'annotations', `${conversationId}.pbtxt`),
    antigravityTitle(`Fixture Antigravity ${name}`),
    { flag: 'wx' }
  )
}

/**
 * Adds three synthetic Antigravity Desktop conversations: Idle with a reply the tool shortened,
 * Running (fixture mode confirms the app), and an open turn quiet for 20 minutes (Unknown). Idle's
 * two tool calls carry inputs: one works and one fails.
 */
async function seedAntigravity(home, at) {
  const root = await newFolder(home, await newFolder(home, home, '.gemini'), 'antigravity')
  await newFolder(home, root, 'brain')
  await newFolder(home, root, 'annotations')
  const openTurn = (start, text) => [
    antigravityPrompt(0, start, text),
    antigravityToolRequest(1, start + 1000, ['view_file']),
    antigravityToolResult(2, start + 2000)
  ]
  const idle = (start) => [
    antigravityPrompt(0, start, 'Synthetic Antigravity question.'),
    antigravityToolRequest(
      1,
      start + 1000,
      ['read_file', 'run_command'],
      [
        { Path: `${CWD}/notes/synthetic.md`, StartLine: '1', EndLine: '8' },
        {
          CommandLine: 'echo synthetic-fixture',
          Cwd: CWD,
          toolSummary: 'Synthetic fixture command',
          toolAction: 'Run'
        }
      ]
    ),
    antigravityToolResult(2, start + 2000),
    antigravityToolResult(3, start + 2500, 'Synthetic fixture failure.'),
    antigravityReply(4, start + 3000, 'Synthetic Antigravity answer, cut short.', true)
  ]
  const conversations = [
    ['idle', at - 5 * MINUTE, idle],
    ['running', at - MINUTE, (start) => openTurn(start, 'Synthetic Antigravity running task.')],
    ['quiet', at - 20 * MINUTE, (start) => openTurn(start, 'Synthetic Antigravity quiet task.')]
  ]
  for (const [name, start, lines] of conversations)
    await writeAntigravityConversation(home, name, start, lines(start))
}

/**
 * Adds an Antigravity skill at `~/.gemini/config/skills/synthetic-antigravity/SKILL.md` and a
 * conversation whose `/synthetic-antigravity` prompt names it. The prompt records the skill's
 * absolute path, so run this on the copied home after launch, after `antigravity-seed`.
 */
async function antigravitySkill(home, at) {
  let folder = await fixtureTarget(home, join(home, '.gemini'))
  for (const part of ['config', 'skills', 'synthetic-antigravity'])
    folder = await newFolder(home, folder, part)
  const skillFile = join(folder, 'SKILL.md')
  await writeFile(
    skillFile,
    '---\nname: synthetic-antigravity\ndescription: Synthetic Antigravity skill.\n---\n# Synthetic Antigravity skill\n\nSynthetic local instructions.\n',
    { flag: 'wx' }
  )
  const start = at - 3000
  await writeAntigravityConversation(home, 'skill', start, [
    antigravityPrompt(
      0,
      start,
      '/synthetic-antigravity Synthetic Antigravity skill request.',
      antigravitySkillBlock('synthetic-antigravity', skillFile) + '\n'
    ),
    antigravityToolRequest(1, start + 1000, ['read_file'], [{ Path: skillFile }]),
    antigravityToolResult(2, start + 2000),
    antigravityReply(3, start + 3000, 'Synthetic Antigravity skill answer.')
  ])
}

export async function simulate(home, step, at = Date.now()) {
  if (!STEPS.includes(step) || !Number.isSafeInteger(at))
    throw new Error('Unknown fixture step or invalid time.')
  await fixtureTarget(home)
  const append = async (path, lines) =>
    appendFile(await fixtureTarget(home, path), lines.join('\n') + '\n')
  const status = async (name, value) => {
    const path = await fixtureTarget(home, registryPath(home, name))
    // Match the tools' atomic registry replacement without following a pre-existing temp symlink.
    const temporary = path + '.fixture-tmp'
    await writeFile(temporary, registry(name, value, at), { flag: 'wx' })
    try {
      await rename(temporary, path)
    } finally {
      await rm(temporary, { force: true })
    }
  }
  const codex = (name, lines) => append(codexPath(home, IDS[name]), lines)
  const transcript = (name, lines) => append(transcriptPath(home, IDS[name]), lines)
  switch (step) {
    case 'antigravity-seed':
      await seedAntigravity(home, at)
      break
    case 'antigravity-skill':
      await antigravitySkill(home, at)
      break
    case 'claude-skill': {
      const name = 'synthetic-skill'
      const directory = join(home, '.claude', 'skills', name)
      await transcript('busy', [
        prompt(
          IDS.busy,
          at,
          `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>\n<command-args>Show the synthetic result before implementation.</command-args>`
        ),
        claude(IDS.busy, 'user', at + 1, {
          isMeta: true,
          message: {
            role: 'user',
            content: `Base directory for this skill: ${directory}\n\n# Synthetic Claude skill\n\nRecorded instructions for a synthetic preview.\n\n<script>globalThis.fixtureInjected=true</script>\n\n![Synthetic image](https://example.invalid/skill.png)`
          }
        }),
        assistant(IDS.busy, at + 2)
      ])
      await status('busy', 'idle')
      break
    }
    case 'skill-references': {
      const skill = (name) => join(home, '.agents', 'skills', name, 'SKILL.md')
      const names = [
        'synthetic-recorded',
        'synthetic-local',
        'synthetic-missing',
        'synthetic-long',
        'synthetic-empty'
      ]
      const text =
        'Review these synthetic skills:\n' +
        names.map((name) => `[$${name}](${skill(name)})`).join('\n') +
        `\n[$synthetic-blocked](${join(home, 'synthetic-other', 'SKILL.md')})\nKeep this surrounding text.`
      const body =
        '---\nname: synthetic-recorded\ndescription: Synthetic recorded skill copy.\n---\n# Synthetic recorded skill\n\nOriginal instructions from the conversation.\n\n<script>globalThis.fixtureInjected=true</script>\n\n![Synthetic image](https://example.invalid/skill.png)'
      await codex('retry', [
        started(id(at), at),
        codexMessage(text, at + 1, 'UserMessage'),
        JSON.stringify({
          timestamp: new Date(at + 2).toISOString(),
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: `<skill>\n<name>synthetic-recorded</name>\n<path>${skill('synthetic-recorded')}</path>\n${body}\n</skill>`
              }
            ]
          }
        }),
        codexMessage('Synthetic skill preview is ready.', at + 3),
        complete(id(at), at + 4)
      ])
      break
    }
    case 'skill-local-updated':
      await writeFile(
        await fixtureTarget(home, join(home, '.agents', 'skills', 'synthetic-local', 'SKILL.md')),
        '# Synthetic updated local skill\n\nUpdated current instructions.'
      )
      break
    case 'skill-missing-restored': {
      const folder = await fixtureTarget(home, join(home, '.agents', 'skills', 'synthetic-missing'))
      await writeFile(
        join(folder, 'SKILL.md'),
        '# Synthetic restored skill\n\nRecovered local content.',
        { flag: 'wx' }
      )
      break
    }
    case 'codex-complete':
      await codex('complete', [
        codexMessage('Synthetic completed reply.', at),
        complete(id(1000), at + 1)
      ])
      break
    case 'codex-error':
      await codex('error', [complete(id(1001), at, true)])
      break
    case 'codex-aborted':
      await codex('aborted', [codexEvent('turn_aborted', at, { turn_id: id(1002) })])
      break
    case 'codex-reply':
      await codex('complete', [
        started(id(at), at),
        codexMessage('Synthetic newer reply.', at + 1),
        complete(id(at), at + 2)
      ])
      break
    case 'codex-new-turn':
      await codex('complete', [
        started(id(at), at),
        codexMessage('Synthetic newer prompt.', at + 1, 'UserMessage')
      ])
      break
    case 'claude-waiting':
      await status('busy', 'waiting')
      break
    case 'claude-denied':
      await transcript('busy', [
        claude(IDS.busy, 'user', at, {
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'synthetic',
                content: 'Synthetic denied tool use.',
                is_error: true
              }
            ]
          }
        }),
        claude(IDS.busy, 'user', at + 1, {
          message: { role: 'user', content: '[Request interrupted by user for tool use]' }
        })
      ])
      await status('busy', 'idle')
      break
    case 'claude-stopped':
      await transcript('stopped', [
        claude(IDS.stopped, 'user', at, {
          message: { role: 'user', content: '[Request interrupted by user]' }
        })
      ])
      await status('stopped', 'idle')
      break
    case 'claude-api-error':
      await transcript('apiError', [assistant(IDS.apiError, at, true)])
      await status('apiError', 'idle')
      break
    case 'claude-reply':
      await transcript('busy', [prompt(IDS.busy, at), assistant(IDS.busy, at + 1)])
      await status('busy', 'idle')
      break
    case 'claude-new-turn':
      await transcript('busy', [prompt(IDS.busy, at)])
      await status('busy', 'busy')
      break
    case 'registry-removed':
      await rm(await fixtureTarget(home, registryPath(home, 'dead')))
      break
    case 'old-resumed':
      await codex('old', [started(id(at), at)])
      break
    case 'malformed-line':
      await codex('malformed', ['{synthetic malformed JSON'])
      break
    case 'read-failure':
      await chmod(await fixtureTarget(home, codexPath(home, IDS.retry)), 0o000)
      break
    case 'read-restored':
      await chmod(await fixtureTarget(home, codexPath(home, IDS.retry)), 0o600)
      break
    case 'missing-codex':
      await rename(
        await fixtureTarget(home, join(home, '.codex')),
        join(home, '.codex-fixture-hidden')
      )
      break
    case 'restore-codex':
      await rename(
        await fixtureTarget(home, join(home, '.codex-fixture-hidden')),
        join(home, '.codex')
      )
      break
  }
  return { step, at }
}
