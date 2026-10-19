import type { JSX } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

function webLink(value: string | undefined): value is string {
  if (!value || value.length > 8192 || /[\s\p{Cc}]/u.test(value)) return false
  try {
    const url = new URL(value)
    return (
      ['https:', 'http:'].includes(url.protocol) && !!url.hostname && !url.username && !url.password
    )
  } catch {
    return false
  }
}

/** No raw HTML plugin, remote resources, or navigation. Only main may open a web link. */
export function SafeMarkdown({
  text,
  onLink
}: {
  text: string
  onLink: (url: string) => void
}): JSX.Element {
  return (
    <div className="markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url, key) => (key === 'href' ? url : '')}
        components={{
          a: ({ href, children }) =>
            webLink(href) ? (
              <a
                href={href}
                title={href}
                draggable={false}
                onClick={(event) => {
                  event.preventDefault()
                  onLink(href)
                }}
              >
                {children}
              </a>
            ) : (
              <>{children}</>
            ),
          img: ({ alt }) => (
            <span className="markdown-image">{alt ? `Image: ${alt}` : 'Image'}</span>
          )
        }}
      >
        {text}
      </Markdown>
    </div>
  )
}
