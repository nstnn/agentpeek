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
export const DEFAULT_SOURCES: Readonly<SourcePreferences> = { codex: true, claude: true }
