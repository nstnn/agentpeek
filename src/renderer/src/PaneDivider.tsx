import { useRef, useState, type JSX } from 'react'
import { clamp } from './pane-layout'

export function PaneDivider({
  label,
  controls,
  value,
  min,
  max,
  onChange,
  onReset
}: {
  label: string
  controls: string
  value: number
  min: number
  max: number
  onChange: (value: number) => void
  onReset: () => void
}): JSX.Element {
  const drag = useRef<{ id: number; x: number; value: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  return (
    <div
      className="pane-divider"
      role="separator"
      aria-label={label}
      aria-controls={controls}
      aria-orientation="vertical"
      aria-valuemin={Math.round(min)}
      aria-valuemax={Math.round(max)}
      aria-valuenow={Math.round(value)}
      aria-valuetext={`${Math.round(value)} pixels`}
      title="Drag to resize · Double-click to reset"
      tabIndex={0}
      data-dragging={dragging || undefined}
      onPointerDown={(event) => {
        if (event.button !== 0 || drag.current) return
        event.preventDefault()
        event.currentTarget.focus({ preventScroll: true })
        event.currentTarget.setPointerCapture(event.pointerId)
        drag.current = { id: event.pointerId, x: event.clientX, value }
        setDragging(true)
      }}
      onPointerMove={(event) => {
        if (!drag.current || drag.current.id !== event.pointerId) return
        onChange(clamp(drag.current.value + event.clientX - drag.current.x, min, max))
      }}
      onPointerUp={(event) => {
        if (!drag.current || drag.current.id !== event.pointerId) return
        drag.current = null
        setDragging(false)
        event.currentTarget.releasePointerCapture(event.pointerId)
      }}
      onPointerCancel={() => {
        if (drag.current) onChange(drag.current.value)
        drag.current = null
        setDragging(false)
      }}
      onLostPointerCapture={() => {
        drag.current = null
        setDragging(false)
      }}
      onDoubleClick={onReset}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && drag.current) {
          event.preventDefault()
          event.stopPropagation()
          const start = drag.current
          drag.current = null
          setDragging(false)
          onChange(start.value)
          event.currentTarget.releasePointerCapture(start.id)
          return
        }
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter'].includes(event.key)) return
        event.preventDefault()
        event.stopPropagation()
        if (event.key === 'Enter') onReset()
        else
          onChange(
            clamp(
              event.key === 'Home'
                ? min
                : event.key === 'End'
                  ? max
                  : value + (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 40 : 10),
              min,
              max
            )
          )
      }}
    />
  )
}
