import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode
} from 'react'
import type { RecentMessages, Session, SessionMessage } from '../../core/session'
import type { AgentPeekApi } from '../../shared/api'
import { rowStatus, sessionTitle, toolName, workspaceName } from './session-display'
import { clockTime, detailStatus } from './detail-status'
import { SessionIcon } from './SessionIcon'
import { SafeMarkdown } from './SafeMarkdown'
import { ReloadSessions } from './session-panels'
import { ToolCalls } from './ToolCalls'
import { PromptSkills, type PromptSkillContext } from './PromptSkills'

const PREVIEW_LIMIT = 6000
const FULL_LIMIT = 200_000
type MessageEntry = { key: number; message: SessionMessage }
type Loaded = {
  revision: string
  sourceEpoch: number
  result: RecentMessages
  entries: MessageEntry[]
}
const NOT_FOUND = { kind: 'not-found' } as const

// The bounded tail can drop timestamp siblings. Match surviving content before matching a
// uniquely updated timestamp, so neither disclosure nor focus migrates to a different message.
function messageEntries(previous: MessageEntry[], messages: SessionMessage[]): MessageEntry[] {
  const remaining = new Set(previous)
  const sameTimestamp = (a: SessionMessage, b: SessionMessage) => a.kind === b.kind && a.at === b.at
  const sameContent = (a: SessionMessage, b: SessionMessage) =>
    sameTimestamp(a, b) &&
    (a.kind === 'tool-calls'
      ? b.kind === 'tool-calls' &&
        a.count === b.count &&
        a.names.join('\0') === b.names.join('\0') &&
        a.calls?.length === b.calls?.length &&
        (a.calls ?? []).every((call, i) => {
          const other = b.calls?.[i]
          return (
            other &&
            call.name === other.name &&
            call.at === other.at &&
            call.input === other.input &&
            call.inputLength === other.inputLength &&
            call.nestedNames?.join('\0') === other.nestedNames?.join('\0')
          )
        })
      : b.kind !== 'tool-calls' && a.text === b.text)
  const matches = messages.map((message) => {
    const candidates = previous.filter((entry) => sameContent(entry.message, message))
    const count = messages.filter((other) => sameContent(other, message)).length
    // Repeated identical entries keep order on append, and retain the suffix on tail eviction.
    const match = candidates
      .slice(Math.max(0, candidates.length - count))
      .find((entry) => remaining.has(entry))
    if (match) remaining.delete(match)
    return match
  })
  let nextKey = Math.max(0, ...previous.map((entry) => entry.key)) + 1
  return messages.map((message, index) => {
    let match = matches[index]
    if (!match) {
      const candidates = [...remaining].filter((entry) => sameTimestamp(entry.message, message))
      const pending = messages.filter((other, i) => !matches[i] && sameTimestamp(other, message))
      if (candidates.length === 1 && pending.length === 1) match = candidates[0]
    }
    if (match) remaining.delete(match)
    return { key: match?.key ?? nextKey++, message }
  })
}

export function SessionDetail({
  session,
  api,
  visible,
  focused,
  paneLabel,
  showTitle = true,
  leadingControl,
  canAutoRead,
  missing,
  monitoringOff = false,
  unavailablePinListed = false,
  onSettings,
  lastSeenAt,
  sourceEpoch,
  reloadPending,
  reloadVersion,
  onReload
}: {
  session: Session
  api: AgentPeekApi
  visible: boolean
  focused: boolean
  paneLabel?: string
  showTitle?: boolean
  leadingControl?: ReactNode
  canAutoRead: () => boolean
  missing: boolean
  monitoringOff?: boolean
  unavailablePinListed?: boolean
  onSettings?: () => void
  lastSeenAt: number | null
  sourceEpoch: number
  reloadPending: boolean
  reloadVersion: number
  onReload: () => Promise<void>
}): JSX.Element {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [retry, setRetry] = useState(0)
  const [actionError, setActionError] = useState<string | null>(null)
  const transcript = useRef<HTMLDivElement>(null)
  const latest = useRef<HTMLDivElement>(null)
  const bottom = useRef<HTMLDivElement>(null)
  const retryButton = useRef<HTMLButtonElement>(null)
  const retryFocused = useRef(false)
  const positioned = useRef(false)
  const scrollPosition = useRef(0)
  const scrollSize = useRef({ width: 0, height: 0 })
  const seen = useRef<string | null>(null)
  const revision = `${session.summary.lastActivityAt}:${session.lastReply?.cursor ?? ''}:${sourceEpoch}:${reloadVersion}`
  const { tool, id } = session.key
  useEffect(() => {
    if (!visible || missing) return
    let active = true
    const receive = (result: RecentMessages) => {
      if (active)
        setLoaded((previous) => ({
          revision,
          sourceEpoch,
          result,
          entries:
            result.kind === 'messages'
              ? messageEntries(
                  previous?.sourceEpoch === sourceEpoch ? previous.entries : [],
                  result.messages
                )
              : []
        }))
    }
    void api.getMessages({ tool, id }, 20).then(receive, () => receive({ kind: 'unreadable' }))
    return () => {
      active = false
    }
  }, [api, tool, id, revision, retry, visible, missing, reloadVersion, sourceEpoch])

  const result = missing
    ? NOT_FOUND
    : loaded?.sourceEpoch === sourceEpoch
      ? loaded.result
      : undefined
  useLayoutEffect(() => {
    if (retryFocused.current && result?.kind === 'messages') {
      retryFocused.current = false
      if (
        document.activeElement === retryButton.current ||
        document.activeElement === document.body
      )
        transcript.current?.focus({ preventScroll: true })
    }
  }, [result])
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
    if (scroller)
      scrollSize.current = { width: scroller.clientWidth, height: scroller.clientHeight }
    // Reflow can shorten the scroll range even without a new message or a
    // visibility change. Reserve space before the browser publishes its clamped
    // scroll event, so widening a pane cannot overwrite the user's offset.
    const observer = new ResizeObserver(() => {
      if (!scroller || !bottom.current || !scroller.clientHeight) return
      const shortage = scrollPosition.current - (scroller.scrollHeight - scroller.clientHeight)
      if (shortage > 0)
        bottom.current.style.height = `${(parseFloat(bottom.current.style.height) || 0) + shortage}px`
      scroller.scrollTop = scrollPosition.current
      scrollSize.current = { width: scroller.clientWidth, height: scroller.clientHeight }
    })
    if (scroller) observer.observe(scroller)
    return () => observer.disconnect()
  }, [visible, result])

  useEffect(() => {
    const cursor = session.lastReply?.cursor
    if (
      !visible ||
      !focused ||
      !canAutoRead() ||
      missing ||
      !cursor ||
      loaded?.revision !== revision ||
      loaded.result.kind !== 'messages' ||
      !(session.attention.newReply || session.attention.error) ||
      seen.current === cursor
    )
      return
    seen.current = cursor
    let active = true
    let completed = false
    void api
      .markRead(session.key, cursor)
      .then((success) => {
        if (!active) return
        completed = true
        if (!success) seen.current = null
      })
      .catch(() => {
        if (!active) return
        completed = true
        seen.current = null
        setActionError("Couldn't mark this session read. Try again.")
      })
    return () => {
      active = false
      if (!completed && seen.current === cursor) seen.current = null
    }
  }, [api, visible, focused, canAutoRead, missing, loaded, revision, session])

  async function action(request: () => Promise<boolean>, failure: string): Promise<void> {
    setActionError(null)
    try {
      if (!(await request())) setActionError(failure)
    } catch {
      setActionError(failure)
    }
  }
  const status = missing
    ? {
        ...rowStatus(session, true),
        ...(monitoringOff ? { label: 'Monitoring off' } : {}),
        callout: undefined
      }
    : detailStatus(session)
  const openName = tool === 'codex' ? 'Open Codex' : 'Open Claude'
  const messages = result?.kind === 'messages' ? result.messages : []
  const entries = result?.kind === 'messages' ? loaded!.entries : []
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
        {showTitle && (
          <div className="detail-heading">
            {leadingControl}
            <DetailTitle title={sessionTitle(session)} />
          </div>
        )}
        <p className="detail-meta" title={session.summary.workspacePath ?? 'No folder'}>
          {toolName(tool)} · {workspaceName(session)}
        </p>
        <p className={`detail-status ${status.kind}`}>
          <SessionIcon kind={status.kind} /> {status.label}
        </p>
        <p className="detail-meta">
          Last seen in AgentPeek:{' '}
          {lastSeenAt === null
            ? 'Unknown'
            : new Date(lastSeenAt).toLocaleString('en-US', { hour12: false })}
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
              tool === 'codex' ? 'Open this session in Codex' : 'Bring the Claude app to the front'
            }
            onClick={() =>
              void action(() => api.openTool(session.key), `Couldn't open ${toolName(tool)}.`)
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
            disabled={missing && !unavailablePinListed}
            onClick={() =>
              void action(
                () => api.setPinned(session.key, !session.pinned),
                "Couldn't update this pin. Try again."
              )
            }
          >
            {session.pinned ? 'Unpin' : 'Pin'}
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
        aria-label={paneLabel ? `${paneLabel} recent messages` : 'Recent messages'}
        tabIndex={0}
        ref={transcript}
        aria-live="off"
        onScroll={(event) => {
          const scroller = event.currentTarget
          const size = scrollSize.current
          // Chromium can deliver the resize-induced clamp before ResizeObserver.
          // Let the observer restore it before accepting another user offset.
          if (
            !visible ||
            (size.width > 0 &&
              (size.width !== scroller.clientWidth || size.height !== scroller.clientHeight))
          )
            return
          scrollPosition.current = scroller.scrollTop
        }}
      >
        {!result ? (
          <div className="message-state" role="status">
            <p>Loading messages…</p>
            <div className="placeholder-bar" />
            <div className="placeholder-bar short" />
            <div className="placeholder-bar" />
          </div>
        ) : monitoringOff ? (
          <div className="message-state">
            <h3>{toolName(tool)} monitoring is off</h3>
            <p>Turn this source on in Settings to continue reading.</p>
            <button type="button" onClick={onSettings}>
              Open Settings
            </button>
          </div>
        ) : result.kind !== 'messages' ? (
          <div className="message-state">
            <h3>Couldn't load messages</h3>
            <p>AgentPeek couldn't read this session's file.</p>
            {missing || result.kind === 'not-found' ? (
              <>
                <p>
                  This session is unavailable. Reload to check its source again; if it stays
                  unavailable, check source access or choose another session.
                </p>
                <ReloadSessions pending={reloadPending} onReload={onReload} />
              </>
            ) : (
              <button
                type="button"
                ref={retryButton}
                onClick={() => {
                  retryFocused.current = true
                  setLoaded(null)
                  setRetry((n) => n + 1)
                }}
              >
                Try Again
              </button>
            )}
          </div>
        ) : (
          <>
            {result.hasOlder && (
              <p className="partial-notice">Showing the last {messages.length} messages</p>
            )}
            {messages.length === 0 && <p className="message-state">No recent messages.</p>}
            {entries.map(({ key, message }, index) => (
              <div key={key}>
                {index === (lastPrompt < 0 ? 0 : lastPrompt) && (
                  <div className="latest-divider" ref={latest}>
                    Latest exchange
                  </div>
                )}
                <Message
                  message={message}
                  tool={tool}
                  activity={session.activity.state}
                  onLink={onLink}
                  promptContext={{
                    sessionKey: session.key,
                    at: message.at,
                    api,
                    visible,
                    ...(message.kind === 'prompt' && message.skill
                      ? { mention: message.skill }
                      : {})
                  }}
                />
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

function DetailTitle({ title }: { title: string }): JSX.Element {
  const id = useId()
  const heading = useRef<HTMLHeadingElement>(null)
  const toggle = useRef<HTMLButtonElement>(null)
  const [expandedTitle, setExpandedTitle] = useState<string | null>(null)
  const expanded = expandedTitle === title
  const [overflows, setOverflows] = useState(false)
  useLayoutEffect(() => {
    const element = heading.current
    if (!element) return
    const measure = () => {
      if (element.closest('[hidden]')) return
      const needed = element.scrollHeight > parseFloat(getComputedStyle(element).lineHeight) * 2 + 1
      if (!needed && document.activeElement === toggle.current)
        element.focus({ preventScroll: true })
      setOverflows(needed)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    measure()
    return () => observer.disconnect()
  }, [title])
  return (
    <div className="detail-title">
      <h2 id={id} ref={heading} tabIndex={-1} className={expanded ? undefined : 'title-preview'}>
        {title}
      </h2>
      {overflows && (
        <button
          type="button"
          ref={toggle}
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpandedTitle(expanded ? null : title)}
        >
          {expanded ? 'Show Less Title' : 'Show Full Title'}
        </button>
      )}
    </div>
  )
}

function Message({
  message,
  tool,
  activity,
  onLink,
  promptContext
}: {
  message: SessionMessage
  tool: Session['key']['tool']
  activity: Session['activity']['state']
  onLink: (url: string) => void
  promptContext?: PromptSkillContext
}): JSX.Element {
  if (message.kind === 'tool-calls') {
    return <ToolCalls message={message} tool={tool} activity={activity} />
  }
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
        promptContext={message.kind === 'prompt' ? promptContext : undefined}
      />
    </article>
  )
}

function MessageText({
  text,
  tool,
  onLink,
  markdown,
  promptContext
}: {
  text: string
  tool: Session['key']['tool']
  onLink: (url: string) => void
  markdown: boolean
  promptContext?: PromptSkillContext
}): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const id = useId()
  const noticeId = useId()
  const block = useRef<HTMLDivElement>(null)
  const toggle = useRef<HTMLButtonElement>(null)
  const reposition = useRef(false)
  const cancelAlignment = useRef<(() => void) | null>(null)
  useEffect(() => () => cancelAlignment.current?.(), [])
  const returnToStart = () => {
    cancelAlignment.current?.()
    const element = block.current
    const scroller = element?.closest<HTMLElement>('.transcript')
    if (element && scroller) {
      const align = () => {
        if (!element.isConnected) return
        scroller.scrollTop +=
          element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 8
      }
      // Chromium may continue the earlier PageDown animation after an immediate jump.
      // Re-align after it settles, but cancel as soon as the user starts another action.
      let timer: number | undefined
      const inputs = ['wheel', 'keydown', 'pointerdown', 'touchstart'] as const
      const cancel = () => {
        window.clearTimeout(timer)
        scroller.removeEventListener('scroll', schedule)
        inputs.forEach((event) => scroller.removeEventListener(event, cancel))
        cancelAlignment.current = null
      }
      const schedule = () => {
        window.clearTimeout(timer)
        timer = window.setTimeout(() => {
          cancel()
          align()
        }, 100)
      }
      cancelAlignment.current = cancel
      scroller.addEventListener('scroll', schedule)
      inputs.forEach((event) => scroller.addEventListener(event, cancel, { passive: true }))
      align()
      schedule()
    }
    toggle.current?.focus({ preventScroll: true })
  }
  useLayoutEffect(() => {
    if (reposition.current) {
      reposition.current = false
      returnToStart()
    }
  }, [expanded])
  const limit = expanded ? FULL_LIMIT : PREVIEW_LIMIT
  const shortened = text.length > limit
  const capped = text.length > FULL_LIMIT
  return (
    <div className="message-text" ref={block}>
      {text.length > PREVIEW_LIMIT && (
        <div className="message-controls">
          <button
            type="button"
            ref={toggle}
            aria-expanded={expanded}
            aria-controls={id}
            aria-describedby={noticeId}
            onClick={() => {
              reposition.current = true
              setExpanded((value) => !value)
            }}
          >
            {expanded ? 'Collapse Message' : 'Show More'}
          </button>
          {expanded && (
            <button type="button" onClick={returnToStart}>
              Back to Message Start
            </button>
          )}
        </div>
      )}
      {text.length > PREVIEW_LIMIT && (
        <p className="truncation-notice" id={noticeId}>
          {shortened
            ? `Showing the first ${limit.toLocaleString('en-US')} of ${text.length.toLocaleString('en-US')} characters.`
            : `Showing all ${text.length.toLocaleString('en-US')} characters.`}
          {capped && (
            <>
              {' '}
              {!expanded && 'Expansion is limited to 200,000 characters. '}
              Open {tool === 'codex' ? 'Codex' : 'Claude'} to read the rest.
            </>
          )}
        </p>
      )}
      <div id={id}>
        {markdown ? (
          <SafeMarkdown text={text.slice(0, limit)} onLink={onLink} />
        ) : promptContext ? (
          <PromptSkills text={text} limit={limit} context={promptContext} onLink={onLink} />
        ) : (
          <div className="prompt-text">{text.slice(0, limit)}</div>
        )}
      </div>
    </div>
  )
}
