import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

// Message text is untrusted Markdown from the Mac (protocol v2). The page shows it inert: raw
// HTML becomes visible text, links become their text, images become "Image: <alt>", and only the
// plain block and inline elements below reach the page. Nothing here fetches, navigates, opens a
// link or calls the Mac: the desktop SafeMarkdown opens links through Electron, so it is not used.

/**
 * The only elements a message may produce; anything else is unwrapped to its children. Headings
 * pass this filter only to reach `COMPONENTS`, which renders them as paragraphs.
 */
const ALLOWED_ELEMENTS = [
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
  'br',
  'strong',
  'em',
  'del',
  'code',
  'pre',
  'blockquote',
  'ul',
  'ol',
  'li',
  'hr',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td'
]

/** Headings in a message would join the page outline; they show as bold paragraphs instead. */
const heading: Components['h1'] = ({ children }) => <p className="md-heading">{children}</p>

const COMPONENTS: Components = {
  h1: heading,
  h2: heading,
  h3: heading,
  h4: heading,
  h5: heading,
  h6: heading
}

/** The mdast node fields this file touches; the types package is not a viewer dependency. */
interface MdNode {
  type: string
  value?: string
  alt?: string | null
  checked?: boolean | null
  children?: MdNode[]
}

/** Rewrites the syntax tree before it becomes elements, so nothing active is ever built. */
function inert(node: MdNode): MdNode[] {
  switch (node.type) {
    case 'html':
      return [{ type: 'text', value: node.value ?? '' }]
    case 'image':
    case 'imageReference':
      return [{ type: 'text', value: node.alt ? `Image: ${node.alt}` : 'Image' }]
    case 'link':
    case 'linkReference':
      // Plain text: the destination is never used.
      return inertChildren(node.children)
    case 'definition':
    case 'footnoteReference':
    case 'footnoteDefinition':
      return []
  }
  if (node.type === 'listItem' && typeof node.checked === 'boolean') {
    const mark: MdNode = { type: 'text', value: node.checked ? '☑ ' : '☐ ' }
    const [first, ...rest] = inertChildren(node.children)
    const children =
      first?.type === 'paragraph'
        ? [{ ...first, children: [mark, ...(first.children ?? [])] }, ...rest]
        : [{ type: 'paragraph', children: [mark] }, ...(first ? [first] : []), ...rest]
    return [{ ...node, checked: null, children }]
  }
  return [node.children ? { ...node, children: inertChildren(node.children) } : node]
}

function inertChildren(children: MdNode[] | undefined): MdNode[] {
  return (children ?? []).flatMap(inert)
}

function remarkInert() {
  return (tree: MdNode) => {
    tree.children = inertChildren(tree.children)
  }
}

export function InertMarkdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <Markdown
        remarkPlugins={[remarkGfm, remarkInert]}
        allowedElements={ALLOWED_ELEMENTS}
        unwrapDisallowed
        skipHtml
        urlTransform={() => ''}
        components={COMPONENTS}
      >
        {text}
      </Markdown>
    </div>
  )
}
