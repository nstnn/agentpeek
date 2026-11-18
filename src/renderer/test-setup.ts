import { afterEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
Element.prototype.scrollIntoView = vi.fn()
globalThis.ResizeObserver = class {
  observe = vi.fn()
  unobserve = vi.fn()
  disconnect = vi.fn()
}
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn(() => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  }))
})

// jsdom cannot supply native modal focus/inertness; those need the built app.
Object.defineProperties(HTMLDialogElement.prototype, {
  showModal: {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.setAttribute('open', '')
    }
  },
  close: {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.removeAttribute('open')
    }
  }
})

// jsdom hides [popover] elements but has no popover API; showing one only needs to make it visible.
Object.defineProperties(HTMLElement.prototype, {
  showPopover: {
    configurable: true,
    value: function (this: HTMLElement) {
      this.style.display = 'block'
    }
  },
  hidePopover: {
    configurable: true,
    value: function (this: HTMLElement) {
      this.style.removeProperty('display')
    }
  }
})
