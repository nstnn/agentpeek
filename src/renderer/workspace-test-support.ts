import { act } from '@testing-library/react'
import { vi } from 'vitest'

/** Deliver actual workspace measurements through the same observer as the app. */
export function mockWorkspaceWidth(initial: number) {
  let width = initial
  const observers = new Set<ResizeObserverCallback>()
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    return new DOMRect(0, 0, this.classList.contains('workspace') ? width : 0, 0)
  })
  vi.spyOn(globalThis, 'ResizeObserver').mockImplementation(function (
    callback: ResizeObserverCallback
  ) {
    observers.add(callback)
    return {
      observe: vi.fn(),
      unobserve: vi.fn(),
      disconnect: () => {
        observers.delete(callback)
      }
    }
  })
  return (next: number) =>
    act(() => {
      width = next
      observers.forEach((callback) =>
        callback(
          [{ contentRect: new DOMRect(0, 0, width, 0) } as ResizeObserverEntry],
          {} as ResizeObserver
        )
      )
    })
}
