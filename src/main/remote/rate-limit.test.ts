import { describe, expect, it } from 'vitest'
import { createRateLimiter } from './rate-limit'

function limiter(start = 1_000) {
  let clock = start
  const limit = createRateLimiter({ perSecond: 10, burst: 20, now: () => clock })
  const takeAll = (count: number) => Array.from({ length: count }, () => limit.take())
  return { limit, takeAll, set: (at: number) => (clock = at) }
}

describe('createRateLimiter', () => {
  it('admits a burst at once, then the steady rate', () => {
    const { limit, takeAll, set } = limiter()
    expect(takeAll(20).every(Boolean)).toBe(true)
    expect(limit.take()).toBe(false)
    set(1_099)
    expect(limit.take()).toBe(false)
    set(1_100)
    expect(limit.take()).toBe(true)
    expect(limit.take()).toBe(false)
    set(2_100)
    expect(takeAll(11)).toEqual([...Array<boolean>(10).fill(true), false])
  })

  it('never saves up more than the burst', () => {
    const { takeAll, set } = limiter()
    set(3_600_000)
    expect(takeAll(21)).toEqual([...Array<boolean>(20).fill(true), false])
  })

  it('neither refills nor locks up when the clock steps back', () => {
    const { limit, takeAll, set } = limiter(10_000)
    takeAll(20)
    set(5_000)
    expect(limit.take()).toBe(false)
    // Time counts again from the new reading.
    set(5_100)
    expect(limit.take()).toBe(true)
  })
})
