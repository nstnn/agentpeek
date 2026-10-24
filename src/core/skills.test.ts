import { describe, expect, it } from 'vitest'
import { MAX_SKILL_CHARACTERS, recordedSkill, skillContent, skillMentions } from './skills'

describe('explicit skill mentions', () => {
  it('preserves text offsets, decodes local paths and supports multiple explicit skill links', () => {
    const text =
      'Use [$pr](</Users/synthetic/My Skills/pr/SKILL.md>) then [$code-review](/Users/synthetic/.agents/skills/code-review/SKILL.md).'
    const refs = skillMentions(text)
    expect(refs.map(({ name, path }) => [name, path])).toEqual([
      ['pr', '/Users/synthetic/My Skills/pr/SKILL.md'],
      ['code-review', '/Users/synthetic/.agents/skills/code-review/SKILL.md']
    ])
    expect(text.slice(refs[0]!.start, refs[0]!.end)).toBe(
      '[$pr](</Users/synthetic/My Skills/pr/SKILL.md>)'
    )
    expect(skillMentions('[$pr](/Users/synthetic/My%20Skills/pr/SKILL.md)')[0]?.path).toBe(
      '/Users/synthetic/My Skills/pr/SKILL.md'
    )
  })
  it('leaves code, quotes, ordinary links, plain mentions and unsafe paths as literal text', () => {
    const link = '[$pr](/Users/synthetic/.agents/skills/pr/SKILL.md)'
    for (const text of [
      '`' + link + '`',
      '```text\n' + link + '\n```',
      '> ' + link,
      '$pr',
      '[pr](/Users/synthetic/.agents/skills/pr/SKILL.md)',
      '[$pr](https://example.com/SKILL.md)',
      '[$pr](/Users/synthetic/%2e%2e/pr/SKILL.md)',
      '[$pr](/Users/synthetic/auth.json)',
      '[$pr](relative/SKILL.md)'
    ])
      expect(skillMentions(text)).toEqual([])
  })
  it('caps cards per prompt while leaving remaining original text available', () => {
    const text = Array.from({ length: 21 }, (_, i) => `[$pr${i}](/synthetic/pr${i}/SKILL.md)`).join(
      ' '
    )
    const refs = skillMentions(text)
    expect(refs).toHaveLength(20)
    expect(text.slice(refs.at(-1)!.end)).toContain('[$pr20]')
  })
})

describe('skill content provenance and bounded display', () => {
  const request = { at: 1, name: 'pr', path: '/synthetic/.agents/skills/pr/SKILL.md' }
  it('requires the exact whole envelope and matching name/path', () => {
    const envelope = `<skill>\n<name>pr</name>\n<path>${request.path}</path>\n# Synthetic recorded skill\n</skill>`
    expect(recordedSkill(envelope, request)).toBe('# Synthetic recorded skill')
    expect(recordedSkill('Example: ' + envelope, request)).toBeNull()
    expect(recordedSkill(envelope, { ...request, name: 'other' })).toBeNull()
    expect(recordedSkill(envelope, { ...request, path: '/other/SKILL.md' })).toBeNull()
  })
  it('extracts a short plain/quoted/folded description and keeps Markdown body inert as data', () => {
    for (const field of [
      'Synthetic description',
      '"Synthetic description"',
      "'Synthetic description'",
      '>\n  Synthetic description'
    ]) {
      expect(
        skillContent(`---\nname: pr\ndescription: ${field}\n---\n# Synthetic body`, 'conversation')
      ).toEqual({
        kind: 'skill',
        source: 'conversation',
        text: '# Synthetic body',
        description: 'Synthetic description',
        truncated: false
      })
    }
    expect(skillContent('---\nname: pr\n# Missing end delimiter', 'local')).toMatchObject({
      text: '---\nname: pr\n# Missing end delimiter',
      description: null
    })
  })
  it('labels capped content and an empty body without inventing missing metadata', () => {
    const result = skillContent('x'.repeat(MAX_SKILL_CHARACTERS + 1), 'local')
    expect(result).toMatchObject({ kind: 'skill', source: 'local', truncated: true })
    if (result.kind === 'skill') expect(result.text).toHaveLength(MAX_SKILL_CHARACTERS)
    expect(skillContent('', 'conversation')).toMatchObject({
      text: '',
      description: null,
      truncated: false
    })
  })
})
