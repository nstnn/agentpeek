import { act, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useNavigationMotion } from './use-navigation-motion'

const sizes = {}
const original = Object.getOwnPropertyDescriptor(Element.prototype, 'animate')
let animations: Array<{
  element: Element
  frames: Keyframe[]
  animation: Animation
  cancel: ReturnType<typeof vi.fn>
}>
let reduced = false
let mediaChanged: (() => void) | undefined

function Fixture({
  visible = true,
  width = 1440,
  contentClass = 'navigation-motion-content'
}: {
  visible?: boolean
  width?: number
  contentClass?: string
}) {
  const workspace = useRef<HTMLDivElement>(null)
  useNavigationMotion(workspace, false, visible, width, sizes)
  return (
    <div ref={workspace} data-testid="workspace">
      <main
        data-motion-region="sessions"
        style={{ flex: `0 0 ${visible ? 300 : 0}px` }}
        hidden={!visible}
        inert={!visible}
        aria-hidden={!visible || undefined}
      >
        <div className={contentClass}>Synthetic list</div>
      </main>
      <aside data-motion-region="main" style={{ flex: `0 0 ${visible ? 950 : 1250}px` }}>
        <div className="navigation-motion-content">Synthetic detail</div>
      </aside>
    </div>
  )
}

beforeEach(() => {
  animations = []
  reduced = false
  mediaChanged = undefined
  vi.spyOn(window, 'matchMedia').mockImplementation(
    () =>
      ({
        get matches() {
          return reduced
        },
        addEventListener: (_: string, listener: () => void) => {
          mediaChanged = listener
        },
        removeEventListener: vi.fn()
      }) as unknown as MediaQueryList
  )
  Object.defineProperty(Element.prototype, 'animate', {
    configurable: true,
    value: function (this: Element, frames: Keyframe[]) {
      const cancel = vi.fn()
      const animation = { onfinish: null, cancel } as unknown as Animation
      animations.push({ element: this, frames, animation, cancel })
      return animation
    }
  })
})

afterEach(() => {
  if (original) Object.defineProperty(Element.prototype, 'animate', original)
  else Reflect.deleteProperty(Element.prototype, 'animate')
})

describe('navigation motion lifecycle', () => {
  it.each(['navigation-motion-content', 'sidebar'])(
    'keeps exiting %s inert, freezes text width and releases temporary styles on finish',
    (contentClass) => {
      const f = render(<Fixture contentClass={contentClass} />)
      expect(animations).toHaveLength(0)
      f.rerender(<Fixture visible={false} contentClass={contentClass} />)
      const exiting = screen.getByText('Synthetic list').parentElement!
      expect(exiting.hidden).toBe(true)
      expect(exiting.hasAttribute('inert')).toBe(true)
      expect(exiting.getAttribute('aria-hidden')).toBe('true')
      expect(exiting.classList.contains('navigation-motion-exit')).toBe(true)
      expect((exiting.firstElementChild as HTMLElement).style.width).toBe('300px')
      expect(animations[0]!.frames).toEqual([
        { flexBasis: '300px', opacity: 1 },
        { flexBasis: '0px', opacity: 0 }
      ])
      act(() =>
        animations.forEach(
          ({ animation }) => void animation.onfinish?.call(animation, {} as AnimationPlaybackEvent)
        )
      )
      expect(exiting.classList.contains('navigation-motion-exit')).toBe(false)
      expect((exiting.firstElementChild as HTMLElement).style.width).toBe('')
      expect(screen.getByTestId('workspace').hasAttribute('data-navigation-motion')).toBe(false)
    }
  )

  it('reverses from the interpolated width/opacity and ignores the cancelled completion', () => {
    const f = render(<Fixture />)
    f.rerender(<Fixture visible={false} />)
    const old = animations[0]!
    const complete = old.animation.onfinish!
    const computed = window.getComputedStyle.bind(window)
    vi.spyOn(window, 'getComputedStyle').mockImplementation((element) =>
      element === old.element
        ? ({ flexBasis: '120px', opacity: '0.4' } as CSSStyleDeclaration)
        : computed(element)
    )
    f.rerender(<Fixture />)
    expect(old.cancel).toHaveBeenCalledOnce()
    expect(animations[2]!.frames[0]).toEqual({ flexBasis: '120px', opacity: 0.4 })
    act(() => {
      void complete.call(old.animation, {} as AnimationPlaybackEvent)
    })
    expect(screen.getByTestId('workspace').hasAttribute('data-navigation-motion')).toBe(true)
    expect((old.element.firstElementChild as HTMLElement).style.width).toBe('300px')
  })

  it('settles immediately on viewport resize and cleans up on unmount', async () => {
    const f = render(<Fixture />)
    f.rerender(<Fixture visible={false} />)
    f.rerender(<Fixture visible={false} width={760} />)
    expect(animations).toHaveLength(2)
    expect(animations.every(({ cancel }) => cancel.mock.calls.length === 1)).toBe(true)
    expect(screen.getByTestId('workspace').hasAttribute('data-navigation-motion')).toBe(false)
    await act(async () => {
      await Promise.resolve()
    })
    f.rerender(<Fixture width={760} />)
    const current = animations.slice(2)
    f.unmount()
    expect(current.every(({ cancel }) => cancel.mock.calls.length === 1)).toBe(true)
  })

  it('does not animate the synchronous capacity change caused by resizing', async () => {
    const f = render(<Fixture />)
    f.rerender(<Fixture width={760} />)
    f.rerender(<Fixture visible={false} width={760} />)
    expect(animations).toHaveLength(0)
    await act(async () => {
      await Promise.resolve()
    })
    f.rerender(<Fixture width={760} />)
    expect(animations).toHaveLength(2)
  })

  it('skips motion with Reduce Motion and cancels an in-flight transition when it becomes enabled', () => {
    reduced = true
    const f = render(<Fixture />)
    f.rerender(<Fixture visible={false} />)
    expect(animations).toHaveLength(0)
    reduced = false
    f.rerender(<Fixture />)
    expect(animations).toHaveLength(2)
    reduced = true
    act(() => mediaChanged?.())
    expect(animations.every(({ cancel }) => cancel.mock.calls.length === 1)).toBe(true)
    expect(screen.getByTestId('workspace').hasAttribute('data-navigation-motion')).toBe(false)
  })
})
