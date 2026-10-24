import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { rolloutLine, taskStartedLine, T0, userMessageLine } from '../../core/codex/test-records'
import type { SkillRequest } from '../../core/skills'
import { readRequestedSkill } from './skill-reader'

let home: string
let path: string
let request: SkillRequest
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'agentpeek-skill-reader-'))
  path = join(home, '.agents', 'skills', 'pr', 'SKILL.md')
  request = { at: T0 + 1, name: 'pr', path }
  await mkdir(dirname(path), { recursive: true })
})
afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})
const prompt = () =>
  userMessageLine(`Use [$pr](${path}) to prepare the synthetic change.`, request.at)
const recorded = (body: string, role = 'user') =>
  rolloutLine(
    'response_item',
    {
      type: 'message',
      role,
      content: [
        {
          type: 'input_text',
          text: `<skill>\n<name>pr</name>\n<path>${path}</path>\n${body}\n</skill>`
        }
      ]
    },
    T0 + 2
  )
const read = (lines: string[], override: Partial<SkillRequest> = {}) =>
  readRequestedSkill({
    lines,
    request: { ...request, ...override },
    home,
    workspace: null,
    fixture: true
  })

describe('skill reads bound to a recent explicit prompt', () => {
  it('prefers recorded skill content over a changed local file and leaves that file untouched', async () => {
    const disk = '# Synthetic current version'
    await writeFile(path, disk)
    expect(
      await read([
        taskStartedLine('synthetic-turn', T0),
        prompt(),
        recorded('# Synthetic original version')
      ])
    ).toMatchObject({ kind: 'skill', source: 'conversation', text: '# Synthetic original version' })
    expect(await readFile(path, 'utf8')).toBe(disk)
    await rm(path)
    expect(await read([prompt(), recorded('# Synthetic original version')])).toMatchObject({
      source: 'conversation'
    })
  })
  it('supports a recorded envelope before the UI prompt event in the same bounded turn', async () => {
    expect(
      await read([
        taskStartedLine('synthetic-turn', T0),
        recorded('# Synthetic original'),
        prompt()
      ])
    ).toMatchObject({ kind: 'skill', source: 'conversation' })
  })
  it('does not borrow an older turn, earlier prompt, assistant example or unrelated skill body', async () => {
    await writeFile(path, '# Synthetic local fallback')
    for (const lines of [
      [prompt(), recorded('# Older'), taskStartedLine('new-turn', T0 + 4), prompt()],
      [userMessageLine('Previous prompt', T0), recorded('# Previous prompt skill'), prompt()],
      [prompt(), recorded('# Assistant example', 'assistant')],
      [prompt(), recorded('# Wrong path').replace(path, '/other/SKILL.md')]
    ])
      expect(await read(lines)).toMatchObject({
        source: 'local',
        text: '# Synthetic local fallback'
      })
  })
  it('rejects forged or expired references even if their target is an allowed existing file', async () => {
    await writeFile(path, '# Synthetic local file')
    for (const override of [
      { at: T0 + 99 },
      { name: 'other' },
      { path: join(home, '.agents', 'skills', 'other', 'SKILL.md') }
    ]) {
      expect(await read([prompt()], override)).toEqual({ kind: 'unavailable', reason: 'not-found' })
    }
    expect(await read([])).toEqual({ kind: 'unavailable', reason: 'not-found' })
  })
  it('labels bounded local reads, missing files and files outside the skill allowlist', async () => {
    await writeFile(path, '# Synthetic local file\n' + 'word '.repeat(40_000))
    const result = await read([prompt()])
    expect(result).toMatchObject({ kind: 'skill', source: 'local', truncated: true })
    if (result.kind === 'skill') expect(result.text.length).toBeLessThanOrEqual(60_000)
    await rm(path)
    expect(await read([prompt()])).toEqual({ kind: 'unavailable', reason: 'not-found' })
    const outside = join(home, 'other', 'SKILL.md')
    await mkdir(dirname(outside), { recursive: true })
    await writeFile(outside, 'Synthetic forbidden file')
    const outsidePrompt = userMessageLine(`[$pr](${outside})`, request.at)
    expect(await read([outsidePrompt], { path: outside })).toEqual({
      kind: 'unavailable',
      reason: 'not-allowed'
    })
  })
})
