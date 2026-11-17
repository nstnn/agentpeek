import { fromMarkdown } from 'mdast-util-from-markdown'
import type { Root, RootContent } from 'mdast'
import {
  isSkillName,
  isSkillPath,
  MAX_SKILL_CHARACTERS,
  MAX_SKILL_MENTIONS,
  type SkillContent,
  type SkillMention,
  type SkillRequest
} from './skill-names'

export * from './skill-names'

/** Recognize only skill links, not code samples, quoted examples, ordinary links or plain $text. */
export function skillMentions(text: string): SkillMention[] {
  const result: SkillMention[] = []
  let root: Root
  try {
    root = fromMarkdown(text.slice(0, 200_000))
  } catch {
    return []
  }
  const pending: (Root | RootContent)[] = [root]
  while (pending.length && result.length < MAX_SKILL_MENTIONS) {
    const node = pending.pop()!
    if (node.type === 'blockquote') continue
    if (node.type === 'link' && node.children.length === 1 && node.children[0]?.type === 'text') {
      const label = node.children[0].value
      const name = label.startsWith('$') ? label.slice(1) : ''
      let path: string
      try {
        path = decodeURIComponent(node.url)
      } catch {
        continue
      }
      const start = node.position?.start.offset
      const end = node.position?.end.offset
      if (isSkillName(name) && isSkillPath(path) && start !== undefined && end !== undefined) {
        result.push({ name, path, start, end })
      }
    } else if ('children' in node) {
      pending.push(...[...node.children].reverse())
    }
  }
  return result
}

/** Strict whole-message skill envelope, treated as conversation text, never instructions. */
export function recordedSkill(text: string, request: SkillRequest): string | null {
  const match =
    /^\s*<skill>\r?\n<name>([^\r\n<>]+)<\/name>\r?\n<path>([^\r\n<>]+)<\/path>\r?\n([\s\S]*)\r?\n<\/skill>\s*$/.exec(
      text
    )
  return match?.[1] === request.name && match[2] === request.path ? (match[3] ?? null) : null
}

/** Body plus a best-effort description preview; no YAML evaluation or executable Markdown. */
export function skillContent(
  text: string,
  source: 'conversation' | 'local',
  truncated = false
): SkillContent {
  const bounded = text.slice(0, MAX_SKILL_CHARACTERS)
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(bounded)
  let description: string | null = null
  if (frontmatter) {
    const lines = frontmatter[1]!.split(/\r?\n/)
    const index = lines.findIndex((line) => line.startsWith('description:'))
    if (index >= 0) {
      let value = lines[index]!.slice('description:'.length).trim()
      if (/^[>|][-+]?$/.test(value)) {
        const parts: string[] = []
        for (let i = index + 1; i < lines.length && /^\s+\S/.test(lines[i]!); i++)
          parts.push(lines[i]!.trim())
        value = parts.join(' ')
      } else if (value.startsWith('"')) {
        try {
          const parsed: unknown = JSON.parse(value)
          value = typeof parsed === 'string' ? parsed : ''
        } catch {
          value = ''
        }
      } else if (value.startsWith("'")) {
        value = value.endsWith("'") ? value.slice(1, -1).replaceAll("''", "'") : ''
      }
      if (value && !value.startsWith('[') && !value.startsWith('{'))
        description = value.slice(0, 500)
    }
  }
  return {
    kind: 'skill',
    source,
    text: frontmatter ? bounded.slice(frontmatter[0].length) : bounded,
    description,
    truncated: truncated || text.length > MAX_SKILL_CHARACTERS
  }
}
