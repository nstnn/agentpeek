import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { PaneDivider } from './PaneDivider'
import { paneLayout } from './pane-layout'

function mount() {
  function Fixture() {
    const [value, setValue] = useState(400)
    return (
      <PaneDivider
        label="Synthetic pane width"
        controls="synthetic-pane"
        value={value}
        min={280}
        max={600}
        onChange={setValue}
        onReset={() => setValue(400)}
      />
    )
  }
  render(<Fixture />)
  return screen.getByRole('separator', { name: 'Synthetic pane width' })
}

describe('pane resizing', () => {
  it('supports keyboard resizing, bounds and reset without handling unrelated keys', () => {
    const divider = mount()
    fireEvent.keyDown(divider, { key: 'ArrowRight' })
    expect(divider.getAttribute('aria-valuenow')).toBe('410')
    fireEvent.keyDown(divider, { key: 'ArrowLeft', shiftKey: true })
    expect(divider.getAttribute('aria-valuenow')).toBe('370')
    fireEvent.keyDown(divider, { key: 'End' })
    fireEvent.keyDown(divider, { key: 'ArrowRight' })
    expect(divider.getAttribute('aria-valuenow')).toBe('600')
    fireEvent.keyDown(divider, { key: 'Home' })
    fireEvent.keyDown(divider, { key: 'ArrowLeft' })
    expect(divider.getAttribute('aria-valuenow')).toBe('280')
    fireEvent.keyDown(divider, { key: 'Enter' })
    expect(divider.getAttribute('aria-valuenow')).toBe('400')
    fireEvent.keyDown(divider, { key: 'ArrowRight' })
    fireEvent.doubleClick(divider)
    expect(divider.getAttribute('aria-valuenow')).toBe('400')
    expect(fireEvent.keyDown(divider, { key: 'Tab' })).toBe(true)
  })

  it('captures a pointer drag, clamps it, cancels with Escape and ignores later motion', () => {
    class TestPointerEvent extends MouseEvent {
      pointerId = 1
    }
    vi.spyOn(window, 'PointerEvent', 'get').mockReturnValue(TestPointerEvent as typeof PointerEvent)
    const divider = mount()
    divider.setPointerCapture = vi.fn()
    const releasePointerCapture = vi.fn()
    divider.releasePointerCapture = releasePointerCapture
    fireEvent.pointerDown(divider, { button: 0, clientX: 400 })
    fireEvent.pointerMove(divider, { clientX: 450 })
    expect(divider.getAttribute('aria-valuenow')).toBe('450')
    fireEvent.pointerMove(divider, { clientX: 900 })
    expect(divider.getAttribute('aria-valuenow')).toBe('600')
    fireEvent.keyDown(divider, { key: 'Escape' })
    expect(divider.getAttribute('aria-valuenow')).toBe('400')
    fireEvent.pointerMove(divider, { clientX: 500 })
    expect(divider.getAttribute('aria-valuenow')).toBe('400')
    expect(releasePointerCapture).toHaveBeenCalled()
    fireEvent.pointerDown(divider, { button: 0, clientX: 400 })
    fireEvent.pointerMove(divider, { clientX: 500 })
    fireEvent.pointerUp(divider)
    fireEvent.pointerMove(divider, { clientX: 550 })
    expect(divider.getAttribute('aria-valuenow')).toBe('500')
    fireEvent.pointerDown(divider, { button: 0, clientX: 500 })
    fireEvent.pointerMove(divider, { clientX: 450 })
    fireEvent.pointerCancel(divider)
    expect(divider.getAttribute('aria-valuenow')).toBe('500')
  })

  it('clamps oversized preferences to the viewport without losing their roomy values', () => {
    const sizes = { sidebar: 300, splitList: 600, splitRatio: 0.8 }
    const visible = { sidebar: true, list: true, details: 2, split: true, narrow: false }
    const compact = paneLayout(1300, sizes, visible)
    expect(compact.sidebar).toBe(300)
    expect(compact.list).toBe(345)
    expect(compact.main).toBe(320)
    expect(compact.second).toBe(320)
    const roomy = paneLayout(2000, sizes, visible)
    expect(roomy.list).toBe(600)
    expect(roomy.main).toBe(765)
    expect(roomy.second).toBe(320)
    const reading = paneLayout(1000, sizes, { ...visible, sidebar: false, list: false })
    expect(reading.main).toBe(675)
    expect(reading.second).toBe(320)
  })
})
