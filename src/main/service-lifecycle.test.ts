import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServiceLifecycle, FOCUS_REFRESH_DELAY_MS } from './service-lifecycle'
import { testService } from './test-support'

afterEach(() => vi.useRealTimers())
describe('service lifecycle', () => {
  it('debounces focus, and an explicit reload consumes the pending focus refresh', async () => {
    vi.useFakeTimers()
    const service = testService()
    const life = createServiceLifecycle(service)
    life.focus()
    life.focus()
    await vi.advanceTimersByTimeAsync(FOCUS_REFRESH_DELAY_MS - 1)
    expect(service.reconcile).not.toHaveBeenCalled()
    await life.reload()
    await vi.runAllTimersAsync()
    expect(service.reconcile).toHaveBeenCalledOnce()
    life.focus()
    await vi.advanceTimersByTimeAsync(FOCUS_REFRESH_DELAY_MS)
    expect(service.reconcile).toHaveBeenCalledTimes(2)
  })
  it('coalesces overlapping reloads and permits a later one', async () => {
    const service = testService()
    let finish!: () => void
    service.reconcile.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finish = resolve
      })
    )
    const life = createServiceLifecycle(service)
    const first = life.reload()
    const second = life.reload()
    expect(service.reconcile).toHaveBeenCalledOnce()
    finish()
    await Promise.all([first, second])
    await life.reload()
    expect(service.reconcile).toHaveBeenCalledTimes(2)
  })
  it('stops once, cancels its timer, and ignores later events', async () => {
    vi.useFakeTimers()
    const service = testService()
    const life = createServiceLifecycle(service)
    life.focus()
    await life.stop()
    await life.stop()
    life.focus()
    await life.reload()
    await vi.runAllTimersAsync()
    expect(service.stop).toHaveBeenCalledOnce()
    expect(service.reconcile).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
