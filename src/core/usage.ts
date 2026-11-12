// A tool's usage limits as its own local files last recorded them. Only Codex records them today:
// each `token_count` event in a rollout carries the account's rate-limit windows. Claude Code keeps
// no such record on disk, so it reports none.
//
// These are account figures, not conversation text, but they are still read-only data from the
// tool's files: they are shown in the window and never logged or sent anywhere.

/** One rate-limit window, such as Codex's 5-hour or weekly limit. */
export interface UsageWindow {
  /** How much of the window is used, 0 to 100 (it can pass 100 once the limit is reached). */
  readonly usedPercent: number
  /** The window's length in minutes, or null when the record does not say. */
  readonly windowMinutes: number | null
  /** When the window resets, in epoch milliseconds, or null when the record does not say. */
  readonly resetsAt: number | null
}

export interface ToolUsageLimits {
  /** When the tool recorded these figures: the record's own timestamp, in epoch milliseconds. */
  readonly observedAt: number
  /** The windows, shortest first. */
  readonly windows: readonly UsageWindow[]
  /** True when the tool recorded that a limit was reached. */
  readonly limitReached: boolean
}

/** A frozen copy, safe to put in a snapshot. */
export function frozenUsageLimits(limits: ToolUsageLimits | null): ToolUsageLimits | null {
  if (limits === null) return null
  return Object.freeze({
    observedAt: limits.observedAt,
    windows: Object.freeze(limits.windows.map((window) => Object.freeze({ ...window }))),
    limitReached: limits.limitReached
  })
}
