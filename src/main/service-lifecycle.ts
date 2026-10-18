import type { SessionsService } from './sessions/service'

export const FOCUS_REFRESH_DELAY_MS = 250

/** Coalesces refreshes and owns the focus timer, so quit leaves no timer behind. */
export function createServiceLifecycle(service: SessionsService) {
  let stopped = false
  let focusTimer: ReturnType<typeof setTimeout> | undefined
  let refreshing: Promise<void> | null = null
  let stopping: Promise<void> | null = null

  function reload(): Promise<void> {
    clearTimeout(focusTimer)
    focusTimer = undefined
    if (stopped) return Promise.resolve()
    refreshing ??= service
      .reconcile()
      .catch(() => undefined)
      .finally(() => {
        refreshing = null
      })
    return refreshing
  }

  return {
    reload,
    focus() {
      if (stopped) return
      clearTimeout(focusTimer)
      focusTimer = setTimeout(() => {
        void reload()
      }, FOCUS_REFRESH_DELAY_MS)
    },
    stop() {
      stopped = true
      clearTimeout(focusTimer)
      focusTimer = undefined
      stopping ??= service.stop()
      return stopping
    }
  }
}
