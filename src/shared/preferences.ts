export const THEMES = ['system', 'light', 'dark'] as const
export type Theme = (typeof THEMES)[number]

export function isTheme(value: unknown): value is Theme {
  return THEMES.some((theme) => theme === value)
}

export const MIN_ZOOM = 80
export const MAX_ZOOM = 150
export type ZoomAction = 'in' | 'out' | 'reset'

export function isZoomPercent(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_ZOOM &&
    value <= MAX_ZOOM &&
    value % 10 === 0
  )
}
import type { AgentTool } from '../core/tools'

export type SourcePreferences = Record<AgentTool, boolean>

/** Settings > Session history choices (REQ-002). */
export const SESSION_DAYS = [7, 30, 90, 365] as const
export const SESSIONS_PER_TOOL = [50, 100, 200, 500] as const

/** Which sessions the list holds: those active in the last `days`, at most `maxPerTool` each. */
export interface SessionRange {
  readonly days: number
  readonly maxPerTool: number
}
export const DEFAULT_SESSION_RANGE: SessionRange = { days: 7, maxPerTool: 50 }

/** A saved or requested range: exactly one of the offered choices for each field. */
export function isSessionRange(value: unknown): value is SessionRange {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const range = value as Record<string, unknown>
  return (
    Object.keys(range).length === 2 &&
    SESSION_DAYS.some((days) => days === range.days) &&
    SESSIONS_PER_TOOL.some((count) => count === range.maxPerTool)
  )
}
export const DEFAULT_SOURCES: Readonly<SourcePreferences> = { codex: true, claude: true }
