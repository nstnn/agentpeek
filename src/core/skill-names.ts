// Skill limits, request shapes and name/path checks, kept free of the Markdown parser so that
// modules the Remote View host and viewer page reach (session types, Claude record parsing) do
// not pull it in. core/skills.ts re-exports everything here.

export const MAX_SKILL_CHARACTERS = 60_000
export const MAX_SKILL_MENTIONS = 20

export interface SkillMention {
  name: string
  path: string
  start: number
  end: number
}

/** A reference in an actual recent user prompt, never an arbitrary file-open request. */
export interface SkillRequest {
  at: number
  name: string
  path: string
}

export type SkillContent =
  | {
      kind: 'skill'
      source: 'conversation' | 'local'
      text: string
      description: string | null
      truncated: boolean
    }
  | { kind: 'unavailable'; reason: 'not-found' | 'not-allowed' | 'unreadable' }

export function isSkillName(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,127}$/.test(value)
}

export function isSkillPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 4096 &&
    value.startsWith('/') &&
    value.endsWith('/SKILL.md') &&
    !/\p{Cc}/u.test(value) &&
    value
      .split('/')
      .slice(1)
      .every((part) => part !== '' && part !== '.' && part !== '..')
  )
}
