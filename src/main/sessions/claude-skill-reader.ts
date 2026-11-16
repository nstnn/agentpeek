import { parseRecord } from '../../core/claude/records'
import { claudePromptSkill } from '../../core/claude/skills'
import { skillContent, type SkillContent, type SkillRequest } from '../../core/skills'

/** Reauthorize the exact prompt/reference. Claude content comes only from the bounded transcript. */
export function readClaudeSkill(lines: readonly string[], request: SkillRequest): SkillContent {
  const records = lines.flatMap((line) => {
    const record = parseRecord(line, { includeSkills: true })
    return record ? [record] : []
  })
  for (let i = records.length - 1; i >= 0; i--) {
    const prompt = records[i]!
    if (prompt.kind !== 'prompt' || prompt.at !== request.at) continue
    const skill = claudePromptSkill(records, i)
    if (skill?.name === request.name && skill.path === request.path)
      return skillContent(skill.text, 'conversation')
  }
  return { kind: 'unavailable', reason: 'not-found' }
}
