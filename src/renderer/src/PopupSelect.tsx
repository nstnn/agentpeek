import { useEffect, useId, useLayoutEffect, useRef, useState, type JSX, type Ref } from 'react'

/**
 * A select-only combo box drawn in AgentPeek's own style. Focus stays on the trigger and the
 * list follows it through aria-activedescendant. The manual popover stays above dialogs and
 * scroll areas.
 */
export function PopupSelect<Value extends number | string>({
  labelId,
  value,
  options,
  prefix,
  className,
  triggerRef,
  disabled = false,
  onChange
}: {
  labelId: string
  value: Value | null
  options: readonly { value: Value; label: string }[]
  prefix?: string
  className?: string
  triggerRef?: Ref<HTMLDivElement>
  disabled?: boolean
  onChange: (value: Value) => void
}): JSX.Element {
  const id = useId()
  const field = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const [expanded, setOpen] = useState(false)
  // A list left open when the field becomes disabled (for example while saving) closes with it.
  const open = expanded && !disabled
  const [active, setActive] = useState(0)
  const current = options.findIndex((option) => option.value === value)
  const optionId = (index: number) => `${id}-option-${index}`

  const show = () => {
    if (disabled) return
    setActive(Math.max(current, 0))
    setOpen(true)
  }
  const choose = (index: number) => {
    setOpen(false)
    const option = options[index]
    if (option && option.value !== value) onChange(option.value)
  }
  const match = (key: string, from: number) => {
    const wanted = key.toLowerCase()
    for (let step = 1; step <= options.length; step++) {
      const index = (from + step) % options.length
      if (options[index]!.label.toLowerCase().startsWith(wanted)) return index
    }
    return -1
  }

  useLayoutEffect(() => {
    const element = list.current
    if (open && element && typeof element.showPopover === 'function') element.showPopover()
  }, [open])
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      if (!field.current?.contains(event.target as Node)) setOpen(false)
    }
    const blur = () => setOpen(false)
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('blur', blur)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('blur', blur)
    }
  }, [open])

  return (
    <div
      ref={field}
      className={className ? `popup-select-field ${className}` : 'popup-select-field'}
    >
      <div
        ref={triggerRef}
        role="combobox"
        tabIndex={0}
        className="popup-select"
        aria-labelledby={labelId}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-activedescendant={open ? optionId(active) : undefined}
        aria-disabled={disabled || undefined}
        onClick={() => (open ? setOpen(false) : show())}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          if (disabled || event.metaKey || event.ctrlKey || event.altKey) return
          const { key } = event
          const last = options.length - 1
          if (!open) {
            if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Enter' || key === ' ') {
              event.preventDefault()
              show()
            } else if (key.length === 1) {
              // Like a native pop-up menu, typing a character while closed picks the next match.
              const index = match(key, current)
              if (index >= 0) {
                event.preventDefault()
                choose(index)
              }
            }
            return
          }
          if (key === 'Tab') {
            setOpen(false)
            return
          }
          let next: number
          if (key === 'ArrowDown') next = Math.min(active + 1, last)
          else if (key === 'ArrowUp') next = Math.max(active - 1, 0)
          else if (key === 'Home' || key === 'PageUp') next = 0
          else if (key === 'End' || key === 'PageDown') next = last
          else if (key === 'Enter' || key === ' ') {
            event.preventDefault()
            choose(active)
            return
          } else if (key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            setOpen(false)
            return
          } else if (key.length === 1) {
            const index = match(key, active)
            if (index < 0) return
            next = index
          } else return
          event.preventDefault()
          setActive(next)
        }}
      >
        <span className="popup-select-value">
          {prefix && <span className="popup-select-prefix">{prefix}</span>}
          {options[current]?.label ?? ''}
        </span>
        <svg
          className="popup-select-chevron"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path
            className="popup-select-chevron-pair"
            d="m3.5 4.75 2.5-2.5 2.5 2.5M3.5 7.25l2.5 2.5 2.5-2.5"
          />
          <path className="popup-select-chevron-down" d="m3 4.5 3 3 3-3" />
        </svg>
      </div>
      {open && (
        <div
          ref={list}
          id={`${id}-list`}
          role="listbox"
          popover="manual"
          className="popup-select-list"
          aria-labelledby={labelId}
        >
          {options.map((option, index) => (
            <div
              key={option.value}
              id={optionId(index)}
              role="option"
              className="popup-select-option"
              aria-selected={index === active}
              data-current={index === current}
              onPointerMove={() => setActive(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(index)}
            >
              <svg className="popup-select-check" viewBox="0 0 12 12" aria-hidden="true">
                <path
                  d="m2.5 6.25 2.25 2.25 4.75-5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              {option.label}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
