import type { ToolUsageLimits, UsageWindow } from '../../core/usage'

// How the connected-source footer shows a tool's usage limits.

/** At this share of a window or more, the meter turns orange. */
export const USAGE_HIGH_PERCENT = 80

export type UsageLevel = 'normal' | 'high' | 'reached'

export interface UsageMeter {
  /** A short name for the window: `5h`, `Week`. */
  label: string
  /** The used share, 0 to 100, or null when the window has reset since the figure was recorded. */
  percent: number | null
  level: UsageLevel
  /** `16%`, or `Reset` once the window has reset. */
  value: string
  /** The spoken and tooltip form: `5-hour limit 16% used, resets 18:30`. */
  description: string
}

export interface UsageDisplay {
  meters: UsageMeter[]
  /** The line under the meters when a limit was reached, with its reset time; otherwise null. */
  note: string | null
  /** The whole summary in one line, for the source button's label and tooltip. */
  summary: string
}

export function usageDisplay(limits: ToolUsageLimits, now: number): UsageDisplay {
  const meters = limits.windows.map((window) => usageMeter(window, now))
  const reached = meters.find((meter) => meter.level === 'reached')
  const reachedWindow = reached ? limits.windows[meters.indexOf(reached)] : undefined
  const note = !reached
    ? null
    : reachedWindow?.resetsAt != null
      ? `Limit reached · resets ${resetTime(reachedWindow.resetsAt, now)}`
      : 'Limit reached'
  const windows = meters.map((meter) => meter.description).join('; ')
  return { meters, note, summary: note === null ? `${windows}.` : `${windows}. ${note}.` }
}

function usageMeter(window: UsageWindow, now: number): UsageMeter {
  const label = windowLabel(window.windowMinutes)
  const longName = windowLongName(window.windowMinutes)
  // A figure from before the window reset says nothing about the new window.
  if (window.resetsAt !== null && window.resetsAt <= now) {
    return {
      label,
      percent: null,
      level: 'normal',
      value: 'Reset',
      description: `${longName} reset since last update`
    }
  }
  const percent = Math.min(100, Math.max(0, Math.round(window.usedPercent)))
  const level: UsageLevel =
    window.usedPercent >= 100 ? 'reached' : percent >= USAGE_HIGH_PERCENT ? 'high' : 'normal'
  const resets = window.resetsAt === null ? '' : `, resets ${resetTime(window.resetsAt, now)}`
  return {
    label,
    percent,
    level,
    value: `${percent}%`,
    description: `${longName} ${percent}% used${resets}`
  }
}

export function windowLabel(minutes: number | null): string {
  if (minutes === null) return 'Limit'
  if (minutes === 7 * 24 * 60) return 'Week'
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)}d`
  if (minutes % 60 === 0) return `${minutes / 60}h`
  return `${Math.round(minutes)}m`
}

function windowLongName(minutes: number | null): string {
  if (minutes === null) return 'Usage limit'
  if (minutes === 7 * 24 * 60) return 'Weekly limit'
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)}-day limit`
  if (minutes % 60 === 0) return `${minutes / 60}-hour limit`
  return `${Math.round(minutes)}-minute limit`
}

/** `18:30` today, otherwise `Mon 09:12` (with a no-break space). */
export function resetTime(at: number, now: number): string {
  const date = new Date(at)
  const time = date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })
  if (date.toDateString() === new Date(now).toDateString()) return time
  // A no-break space keeps the day and time on one line when the note wraps.
  return `${date.toLocaleDateString('en-US', { weekday: 'short' })}\u00a0${time}`
}
