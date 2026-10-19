import { useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react'
import type { RecentMessages, Session, SessionMessage } from '../../core/session'
import type { AgentPeekApi } from '../../shared/api'
import { sessionTitle, toolName, workspaceName } from './session-display'
import { clockTime, detailStatus } from './detail-status'
import { SessionIcon } from './SessionIcon'
import { SafeMarkdown } from './SafeMarkdown'

const PREVIEW_LIMIT = 6000
const FULL_LIMIT = 200_000
type Loaded = { revision: string; result: RecentMessages }
const NOT_FOUND = { kind: 'not-found' } as const

export function SessionDetail({
  session,
  api,
  visible,
  focused,
  missing,
  confirmedAt
}: {
  session: Session
  api: AgentPeekApi
  visible: boolean
  focused: boolean
  missing: boolean
  confirmedAt: number
}): JSX.Element {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [retry, setRetry] = useState(0)
  const [actionError, setActionError] = useState<string | null>(null)
  const transcript = useRef<HTMLDivElement>(null)
  const latest = useRef<HTMLDivElement>(null)
  const bottom = useRef<HTMLDivElement>(null)
  const positioned = useRef(false)
  const scrollPosition = useRef(0)
  const seen = useRef<string | null>(null)
  const revision = `${session.summary.lastActivityAt}:${session.lastReply?.cursor ?? ''}:${missing}`
  const { tool, id } = session.key
  useEffect(() => {
    if (!visible) return
    let active = true
    const receive = (result: RecentMessages) => {
      if (active) setLoaded({ revision, result })
    }
    void api.getMessages({ tool, id }, 20).then(receive, () => receive({ kind: 'unreadable' }))
    return () => {
      active = false
    }
  }, [api, tool, id, revision, retry, visible])

  const result = missing ? NOT_FOUND : loaded?.result
  useLayoutEffect(() => {
    if (!visible || result?.kind !== 'messages') return
    const scroller = transcript.current
    const divider = latest.current
    if (scroller && divider && bottom.current) {
      if (!positioned.current) {
        bottom.current.style.height = `${Math.max(0, scroller.clientHeight - (bottom.current.getBoundingClientRect().top - divider.getBoundingClientRect().top) - 24)}px`
        scroller.scrollTop +=
          divider.getBoundingClientRect().top - scroller.getBoundingClientRect().top
        scrollPosition.current = scroller.scrollTop
      } else {
        // Dropping the oldest entry of a bounded tail can shorten the scroll range. Reserve
        // enough space before restoring the user's offset, so Chromium cannot clamp it upward.
        const shortage = scrollPosition.current - (scroller.scrollHeight - scroller.clientHeight)
        if (shortage > 0)
          bottom.current.style.height = `${(parseFloat(bottom.current.style.height) || 0) + shortage}px`
        scroller.scrollTop = scrollPosition.current
      }
    }
    positioned.current = true
  }, [visible, result])

  useEffect(() => {
    const cursor = session.lastReply?.cursor
    if (
      !visible ||
      !focused ||
      missing ||
      !cursor ||
      loaded?.revision !== revision ||
      loaded.result.kind !== 'messages' ||
      !(session.attention.newReply || session.attention.error) ||
      seen.current === cursor
    )
      return
    seen.current = cursor
    void api
      .markRead(session.key, cursor)
      .then((success) => {
        if (!success) seen.current = null
      })
      .catch(() => {
        seen.current = null
        setActionError("Couldn't mark this session read. Try again.")
      })
  }, [api, visible, focused, missing, loaded, revision, session])

  async function action(request: () => Promise<boolean>, failure: string): Promise<void> {
    setActionError(null)
    try {
      if (!(await request())) setActionError(failure)
    } catch {
      setActionError(failure)
    }
  }
  const status = detailStatus(session)
  const openName = tool === 'codex' ? 'Open Codex' : 'Open Claude'
  const messages = result?.kind === 'messages' ? result.messages : []
  let lastPrompt = -1
  messages.forEach((message, index) => {
    if (message.kind === 'prompt') lastPrompt = index
  })
  const error = result?.kind === 'messages' ? result.error : undefined
  const errorMessage = error && error.cursor === session.lastReply?.cursor ? error.message : null
  const onLink = (url: string) => void action(() => api.openLink(url), "Couldn't open this link.")
  return (
    <>
      <header className="detail-header">
        <h2>{sessionTitle(session)}</h2>
        <p className="detail-meta" title={session.summary.workspacePath ?? 'No folder'}>
          {toolName(tool)} · {workspaceName(session)}
        </p>
        <p className={`detail-status ${status.kind}`}>
          <SessionIcon kind={status.kind} /> {status.label} · as of {clockTime(confirmedAt)}
        </p>
        {status.callout && (
          <div className={`detail-callout ${status.kind}`}>
            <p>{status.callout}</p>
            {errorMessage && (
              <blockquote>
                <MessageText text={errorMessage} tool={tool} onLink={onLink} markdown={false} />
              </blockquote>
            )}
          </div>
        )}
        <div className="detail-actions">
          <button
            type="button"
            disabled={missing}
            title={
              tool === 'codex'
                ? 'Bring the Codex app (ChatGPT) to the front'
                : 'Bring the Claude app to the front'
            }
            onClick={() =>
              void action(() => api.openTool(tool), `Couldn't open ${toolName(tool)}.`)
            }
          >
            {openName}
          </button>
          <button
            type="button"
            disabled={missing || !(session.attention.newReply || session.attention.error)}
            onClick={() =>
              void action(
                () => api.markRead(session.key),
                "Couldn't mark this session read. Try again."
              )
            }
          >
            Mark Read
          </button>
          <button
            type="button"
            disabled={missing}
            onClick={() =>
              void action(
                () => api.setPinned(session.key, !session.pinned),
                "Couldn't update this pin. Try again."
              )
            }
          >
            {session.pinned ? 'Unpin' : 'Pin'}
          </button>
          <button
            type="button"
            disabled={missing}
            onClick={() =>
              void action(() => api.copySessionId(session.key), "Couldn't copy the session ID.")
            }
          >
            Copy Session ID
          </button>
        </div>
        {actionError && (
          <p className="action-error" role="status">
            {actionError}
          </p>
        )}
      </header>
      <div
        className="transcript"
        role="region"
        aria-label="Recent messages"
        tabIndex={0}
        ref={transcript}
        aria-live="off"
        onScroll={(event) => {
          scrollPosition.current = event.currentTarget.scrollTop
        }}
      >
        {!result ? (
          <div className="message-state" role="status">
            <p>Loading messages…</p>
            <div className="placeholder-bar" />
            <div className="placeholder-bar short" />
            <div className="placeholder-bar" />
          </div>
        ) : result.kind !== 'messages' ? (
          <div className="message-state">
            <h3>Couldn't load messages</h3>
            <p>AgentPeek couldn't read this session's file.</p>
            {missing && <p>This session is no longer available.</p>}
            <button
              type="button"
              onClick={() => {
                setLoaded(null)
                setRetry((n) => n + 1)
              }}
            >
              Try Again
            </button>
          </div>
        ) : (
          <>
            {result.hasOlder && (
              <p className="partial-notice">Showing the last {messages.length} messages</p>
            )}
            {messages.length === 0 && <p className="message-state">No recent messages.</p>}
            {messages.map((message, index) => (
              <div
                key={`${message.kind}:${message.at}:${messages.slice(0, index).filter((m) => m.kind === message.kind && m.at === message.at).length}`}
              >
                {index === (lastPrompt < 0 ? 0 : lastPrompt) && (
                  <div className="latest-divider" ref={latest}>
                    Latest exchange
                  </div>
                )}
                <Message message={message} tool={tool} onLink={onLink} />
              </div>
            ))}
            {tool === 'claude' &&
              session.lastReply?.isError &&
              !session.lastReply.newerTurnStarted && (
                <p className="transcript-ending">
                  No final reply: the turn ended with an API error.
                </p>
              )}
            {session.activity.state === 'running' && (
              <p className="transcript-ending">Still running — no final reply yet.</p>
            )}
            <div ref={bottom} aria-hidden="true" />
          </>
        )}
      </div>
    </>
  )
}

function Message({
  message,
  tool,
  onLink
}: {
  message: SessionMessage
  tool: Session['key']['tool']
  onLink: (url: string) => void
}): JSX.Element {
  if (message.kind === 'tool-calls')
    return (
      <p className="tool-summary">
        {message.count} tool {message.count === 1 ? 'call' : 'calls'} · {message.names.join(', ')}
      </p>
    )
  return (
    <article className={`message ${message.kind}`}>
      <header>
        <strong>{message.kind === 'prompt' ? 'You' : tool === 'codex' ? 'Codex' : 'Claude'}</strong>
        <time dateTime={new Date(message.at).toISOString()}>{clockTime(message.at)}</time>
      </header>
      <MessageText
        text={message.text}
        tool={tool}
        onLink={onLink}
        markdown={message.kind === 'reply'}
      />
    </article>
  )
}

function MessageText({
  text,
  tool,
  onLink,
  markdown
}: {
  text: string
  tool: Session['key']['tool']
  onLink: (url: string) => void
  markdown: boolean
}): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const limit = expanded ? FULL_LIMIT : PREVIEW_LIMIT
  const shortened = text.length > limit
  return (
    <>
      {markdown ? (
        <SafeMarkdown text={text.slice(0, limit)} onLink={onLink} />
      ) : (
        <div className="prompt-text">{text.slice(0, limit)}</div>
      )}
      {shortened && (
        <p className="truncation-notice">
          Showing the first {limit.toLocaleString('en-US')} of {text.length.toLocaleString('en-US')}{' '}
          characters.
        </p>
      )}
      {!expanded && shortened && (
        <button type="button" onClick={() => setExpanded(true)}>
          Show Full Message
        </button>
      )}
      {expanded && shortened && (
        <p className="truncation-notice">
          Open {tool === 'codex' ? 'Codex' : 'Claude'} to read the rest.
        </p>
      )}
    </>
  )
}
