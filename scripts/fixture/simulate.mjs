import { appendFile, chmod, rename, rm, writeFile } from 'node:fs/promises'
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
  registry
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
  'skill-local-updated',
  'skill-missing-restored'
])

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
