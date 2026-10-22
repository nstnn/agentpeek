import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import type { PaneSizes } from './pane-layout'

const DURATION = 220
const EASING = 'cubic-bezier(0.22, 1, 0.36, 1)'

/** Animate presentation only; hidden panes keep their existing focus/read contract. */
export function useNavigationMotion(
  workspace: RefObject<HTMLDivElement | null>,
  collapsed: boolean,
  listVisible: boolean,
  width: number,
  sizes: PaneSizes
) {
  const previous = useRef<{
    collapsed: boolean
    listVisible: boolean
    width: number
    sizes: PaneSizes
    widths: Map<string, number>
  } | null>(null)
  const running = useRef(
    new Map<HTMLElement, { animation: Animation; content: HTMLElement | null }>()
  )
  const activeWorkspace = useRef<HTMLDivElement | null>(null)
  const resizingLayout = useRef(false)
  const stop = useCallback(() => {
    for (const [element, { animation, content }] of running.current) {
      animation.onfinish = null
      animation.cancel()
      element.classList.remove('navigation-motion-exit')
      content?.style.removeProperty('width')
    }
    running.current.clear()
    activeWorkspace.current?.removeAttribute('data-navigation-motion')
  }, [])

  useLayoutEffect(() => {
    const container = workspace.current
    if (!container) return
    activeWorkspace.current = container
    const regions = Array.from(
      container.querySelectorAll<HTMLElement>(':scope > [data-motion-region]')
    )
    const targets = new Map(
      regions.map((element) => [
        element.dataset.motionRegion!,
        element.hidden ? 0 : Number.parseFloat(element.style.flexBasis)
      ])
    )
    const before = previous.current
    const changed = regions.some(
      (element) =>
        targets.get(element.dataset.motionRegion!) !==
        before?.widths.get(element.dataset.motionRegion!)
    )
    const resizing = before && (before.width !== width || before.sizes !== sizes)
    if (resizing) {
      // Capacity is published in a layout effect and can cause another synchronous
      // render. That follow-up belongs to the same resize, not a navigation toggle.
      resizingLayout.current = true
      queueMicrotask(() => {
        resizingLayout.current = false
      })
    }
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const toggled = before && (before.collapsed !== collapsed || before.listVisible !== listVisible)
    previous.current = { collapsed, listVisible, width, sizes, widths: targets }
    if (!before || resizingLayout.current || reduced || typeof container.animate !== 'function') {
      stop()
      return
    }
    if (!changed || (!toggled && running.current.size === 0)) return

    // Read the current interpolated values before cancelling, so repeated toggles
    // reverse from the visible position rather than snapping to an old endpoint.
    const starts = regions.map((element) => {
      const animated = running.current.has(element)
      const style = animated ? getComputedStyle(element) : null
      return {
        element,
        from: animated
          ? Number.parseFloat(style!.flexBasis)
          : (before.widths.get(element.dataset.motionRegion!) ?? 0),
        opacity: animated
          ? Number.parseFloat(style!.opacity)
          : (before.widths.get(element.dataset.motionRegion!) ?? 0) === 0
            ? 0
            : 1
      }
    })
    stop()
    for (const { element, from, opacity } of starts) {
      const to = targets.get(element.dataset.motionRegion!)!
      if (!Number.isFinite(from) || !Number.isFinite(to) || Math.abs(from - to) < 0.1) continue
      const content = element.querySelector<HTMLElement>(
        ':scope > .navigation-motion-content, :scope > .sidebar'
      )
      // Clip a stable text layout while the outside edge moves; never scale text.
      if (content) content.style.width = `${element.hidden ? from : to}px`
      if (element.hidden) element.classList.add('navigation-motion-exit')
      const animation = element.animate(
        [
          { flexBasis: `${from}px`, opacity },
          { flexBasis: `${to}px`, opacity: element.hidden ? 0 : 1 }
        ],
        { duration: DURATION, easing: EASING }
      )
      running.current.set(element, { animation, content })
      animation.onfinish = () => {
        if (running.current.get(element)?.animation !== animation) return
        element.classList.remove('navigation-motion-exit')
        content?.style.removeProperty('width')
        running.current.delete(element)
        if (!running.current.size) container.removeAttribute('data-navigation-motion')
      }
    }
    if (running.current.size) container.setAttribute('data-navigation-motion', '')
  })

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const changed = () => {
      if (media.matches) stop()
    }
    media.addEventListener('change', changed)
    return () => {
      media.removeEventListener('change', changed)
      stop()
    }
  }, [stop])
  return stop
}
