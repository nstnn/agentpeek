import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import type { AppSnapshot } from '../../shared/api'

/** Keep the selected row at the same viewport position when earlier groups change size. */
export function useListAnchor(selectedId: string | null, snapshot: AppSnapshot | null) {
  const list = useRef<HTMLDivElement>(null)
  const head = useRef<HTMLDivElement>(null)
  const tail = useRef<HTMLDivElement>(null)
  const anchor = useRef<{ key: string; offset: number; snapshot: AppSnapshot | null } | null>(null)
  const remember = useCallback(() => {
    const container = list.current
    const row = selectedId && document.getElementById(`session-${selectedId}`)
    anchor.current =
      container && row
        ? {
            key: selectedId,
            offset: row.getBoundingClientRect().top - container.getBoundingClientRect().top,
            snapshot
          }
        : null
  }, [selectedId, snapshot])

  useLayoutEffect(() => {
    const container = list.current
    const before = head.current
    const after = tail.current
    if (!container || !before || !after) return
    const old = anchor.current
    const row = selectedId && document.getElementById(`session-${selectedId}`)
    if (!row || old?.key !== selectedId) {
      before.style.height = '0px'
      after.style.height = '0px'
    } else if (old.snapshot !== snapshot) {
      const offset = row.getBoundingClientRect().top - container.getBoundingClientRect().top
      let target = container.scrollTop + offset - old.offset
      // A short list has no scroll range. Reserve only the space needed to keep the row still.
      if (target < 0) {
        before.style.height = `${(parseFloat(before.style.height) || 0) - target}px`
        target = 0
      }
      const contentEnd =
        after.getBoundingClientRect().top -
        container.getBoundingClientRect().top +
        container.scrollTop
      if (target > container.scrollHeight - container.clientHeight) {
        after.style.height = `${Math.max(parseFloat(after.style.height) || 0, container.clientHeight + target - contentEnd)}px`
      }
      container.scrollTop = target
    }
    remember()
  })

  // User scrolling and resizing establish a new anchor; neither is undone by the next snapshot.
  useEffect(() => {
    if (!list.current || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(remember)
    observer.observe(list.current)
    return () => observer.disconnect()
  }, [remember])
  return { list, head, tail, remember }
}
