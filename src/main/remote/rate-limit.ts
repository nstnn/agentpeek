/** Admits requests at a steady rate with room for a burst. */
export interface RateLimiter {
  /** Spends one request; false when none is left. */
  take(): boolean
}

/**
 * A token bucket: it starts full with `burst` requests and refills `perSecond` a second, never
 * above `burst`. A clock that steps back only pauses the refill, so a changed Mac clock can neither
 * mint requests nor lock the listener.
 */
export function createRateLimiter(options: {
  perSecond: number
  burst: number
  now: () => number
}): RateLimiter {
  const { perSecond, burst, now } = options
  let tokens = burst
  let last = now()
  return {
    take() {
      const at = now()
      tokens = Math.min(burst, tokens + (Math.max(0, at - last) * perSecond) / 1000)
      last = at
      if (tokens < 1) return false
      tokens -= 1
      return true
    }
  }
}
