import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { InertMarkdown } from './InertMarkdown'

// Hostile synthetic Markdown: nothing active or resource-loading may reach the DOM. The real
// browser run (remote/web/browser/privacy.test.ts) also checks no script runs and nothing loads.

afterEach(cleanup)

// Blank lines between blocks, so each HTML block ends and the Markdown after it is parsed.
const HOSTILE = [
  '# Big heading',
  '<script>window.pwned = 1</script>',
  '<img src="https://example.invalid/a.png" onerror="window.pwned = 2">',
  '<iframe src="https://example.invalid/"></iframe>',
  '<style>body { display: none }</style>',
  '<a href="https://example.invalid/">raw link</a>',
  '[click me](javascript:alert(1)) and [web](https://example.invalid/x)',
  '![tracking pixel](https://example.invalid/p.gif)',
  '<https://example.invalid/auto> and www.example.invalid',
  '[ref link][r] ![ref image][r]',
  '',
  '[r]: https://example.invalid/r',
  '',
  'Footnote[^1].',
  '',
  '[^1]: https://example.invalid/f',
  '',
  '- [x] done task',
  '- [ ] open task',
  '',
  '<svg onload="window.pwned = 3"></svg> <details open><summary>s</summary>d</details>',
  '',
  '| a | b |',
  '| - | - |',
  '| <b>1</b> | `2` |',
  '',
  '```html',
  '<script>also text</script>',
  '```'
]
  .join('\n')
  .replace(/^(<[a-z!].*)$/gm, '$1\n')

const FORBIDDEN =
  'a, img, script, iframe, style, svg, input, details, summary, h1, h2, h3, h4, h5, h6, link, object, embed, video, audio, source, form, button, sup, section'

it('renders hostile Markdown with no active element, attribute or resource', () => {
  const { container } = render(<InertMarkdown text={HOSTILE} />)
  expect(container.querySelectorAll(FORBIDDEN)).toHaveLength(0)
  for (const element of container.querySelectorAll('*')) {
    for (const { name } of element.attributes) {
      expect(['class']).toContain(name)
    }
  }
  expect((window as { pwned?: number }).pwned).toBeUndefined()
})

it('shows raw HTML, link text and image alt as visible text', () => {
  const { container } = render(<InertMarkdown text={HOSTILE} />)
  const text = container.textContent ?? ''
  expect(text).toContain('<script>window.pwned = 1</script>')
  expect(text).toContain('<a href="https://example.invalid/">')
  expect(text).toContain('click me')
  expect(text).toContain('Image: tracking pixel')
  expect(text).toContain('Image: ref image')
  expect(text).toContain('☑ done task')
  expect(text).toContain('☐ open task')
  // A link's destination never becomes text or an attribute.
  expect(text).not.toContain('javascript:')
  expect(text).not.toContain('https://example.invalid/x')
  // Headings are bold paragraphs, so a message cannot add to the page outline.
  expect(container.querySelector('p.md-heading')?.textContent).toBe('Big heading')
  // Code blocks keep their text.
  expect(container.querySelector('pre code')?.textContent).toContain('<script>also text</script>')
})

it('keeps ordinary formatting', () => {
  const { container } = render(<InertMarkdown text={'Some **bold**, _em_, ~~del~~ and `code`.'} />)
  expect(container.querySelector('strong')?.textContent).toBe('bold')
  expect(container.querySelector('em')?.textContent).toBe('em')
  expect(container.querySelector('del')?.textContent).toBe('del')
  expect(container.querySelector('code')?.textContent).toBe('code')
})
