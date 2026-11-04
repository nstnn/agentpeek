import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { InertMarkdown } from './InertMarkdown'

// TASK-034: malformed and hostile Markdown beyond the TASK-033 sample. Whatever the input, the
// output holds no active or resource-loading element and no attribute but `class`, and rendering
// stays bounded. Synthetic text only.

afterEach(cleanup)

const ALLOWED_ATTRIBUTES = new Set(['class'])
const ACTIVE =
  'a, img, script, iframe, frame, object, embed, style, link, meta, base, form, input, button, svg, math, video, audio, source, picture, details, template, textarea, select'

function check(markdown: string, name: string): void {
  const { container } = render(<InertMarkdown text={markdown} />)
  expect(container.querySelectorAll(ACTIVE).length, name).toBe(0)
  for (const element of container.querySelectorAll('*')) {
    for (const attribute of element.getAttributeNames()) {
      expect(ALLOWED_ATTRIBUTES.has(attribute), `${name}: ${element.tagName} ${attribute}`).toBe(
        true
      )
    }
  }
  cleanup()
}

const CASES: Record<string, string> = {
  'entity-encoded scheme': '[x](&#106;avascript:alert(1)) [y](java&#x0A;script:alert(1))',
  'data and vbscript links': '[d](data:text/html,<script>1</script>) [v](vbscript:msgbox(1))',
  'data image': '![p](data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)',
  'autolinks of other schemes':
    '<javascript:alert(1)> <mailto:a@example.invalid> <file:///etc/hosts>',
  'reference with title': '[a][r]\n\n[r]: https://example.invalid "title onmouseover=alert(1)"',
  'unclosed fence': '```js\n<script>window.pwned = 1</script>\nno end',
  'unclosed html': '<div onclick="x"\n\n<img src=x\n\n<a href="https://example.invalid"',
  'html comment': '<!-- <img src=x onerror=alert(1)> -->text',
  'cdata and processing': '<![CDATA[<script>1</script>]]> <?php echo 1 ?>',
  'nested html in table': '| a |\n| - |\n| <img src=x> <a href=y>z</a> |',
  'html in heading and list': '# <img src=x>\n\n- <script>1</script>\n- [x] <iframe></iframe>',
  'svg and math':
    '<svg><script>1</script></svg>\n\n<math><mi xlink:href="javascript:1">x</mi></math>',
  'link in image alt': '![[inner](https://example.invalid)](https://example.invalid/i.png)',
  'footnote with link': 'n[^a]\n\n[^a]: [x](https://example.invalid) <img src=x>',
  'bare urls': 'www.example.invalid https://example.invalid/x?y=1 a@example.invalid',
  'style and form':
    '<style>*{}</style>\n\n<form action="https://example.invalid"><input><button>b</button></form>',
  'meta refresh': '<meta http-equiv="refresh" content="0;url=https://example.invalid">',
  'emphasis soup': '*'.repeat(500) + 'x' + '_'.repeat(500),
  'bracket soup': '['.repeat(2_000) + 'x' + ']('.repeat(2_000)
}

it('renders every hostile case without an active element or attribute', () => {
  for (const [name, markdown] of Object.entries(CASES)) check(markdown, name)
})

it('deep nesting and a long message render within a bounded time', () => {
  const deep: Record<string, string> = {
    quotes: `${'>'.repeat(1_000)} deep`,
    lists: Array.from({ length: 300 }, (_, i) => `${'  '.repeat(i)}- item`).join('\n'),
    table: [
      '| a | b |',
      '| - | - |',
      ...Array.from({ length: 2_000 }, () => '| <b>x</b> | y |')
    ].join('\n'),
    // About the 64 KiB budget of one response.
    long: Array.from(
      { length: 1_000 },
      (_, i) => `Line ${i} with [link](https://example.invalid/${i}) and <b>x</b>`
    ).join('\n')
  }
  for (const [name, markdown] of Object.entries(deep)) {
    const started = performance.now()
    check(markdown, name)
    expect(performance.now() - started, name).toBeLessThan(5_000)
  }
})
