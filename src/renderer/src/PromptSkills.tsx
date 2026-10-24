import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { SessionKey } from '../../core/session'
import { skillMentions, type SkillContent, type SkillMention } from '../../core/skills'
import type { AgentPeekApi } from '../../shared/api'
import { SafeMarkdown } from './SafeMarkdown'

export interface PromptSkillContext {
  sessionKey: SessionKey
  at: number
  api: AgentPeekApi
  visible: boolean
}

export function PromptSkills({
  text,
  limit = text.length,
  context,
  onLink
}: {
  text: string
  limit?: number
  context: PromptSkillContext
  onLink: (url: string) => void
}): JSX.Element {
  const mentions = useMemo(
    () => skillMentions(text).filter((mention) => mention.end <= limit),
    [text, limit]
  )
  const parts: JSX.Element[] = []
  let offset = 0
  for (const mention of mentions) {
    parts.push(<span key={`text-${offset}`}>{text.slice(offset, mention.start)}</span>)
    parts.push(
      <SkillCard
        key={`${context.sessionKey.tool}:${context.sessionKey.id}:${context.at}:${mention.start}:${mention.name}:${mention.path}`}
        mention={mention}
        context={context}
        onLink={onLink}
      />
    )
    offset = mention.end
  }
  parts.push(<span key={`text-${offset}`}>{text.slice(offset, limit)}</span>)
  return <div className="prompt-text">{parts}</div>
}

function SkillCard({
  mention,
  context,
  onLink
}: {
  mention: SkillMention
  context: PromptSkillContext
  onLink: (url: string) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [result, setResult] = useState<SkillContent | null>(null)
  const cardRef = useRef<HTMLDetailsElement>(null)
  const retry = () => {
    cardRef.current?.querySelector<HTMLElement>(':scope > summary')?.focus({ preventScroll: true })
    setResult(null)
  }
  const {
    api,
    at,
    visible,
    sessionKey: { tool, id }
  } = context
  const { name, path } = mention
  useEffect(() => {
    if (!open || !visible || result !== null) return
    let active = true
    void api.getSkill({ tool, id }, { at, name, path }).then(
      (value) => {
        if (active) setResult(value)
      },
      () => {
        if (active) setResult({ kind: 'unavailable', reason: 'unreadable' })
      }
    )
    return () => {
      active = false
    }
  }, [api, at, id, name, open, path, result, tool, visible])
  return (
    <details
      ref={cardRef}
      className="skill-card"
      onToggle={(event) => {
        if (event.target !== event.currentTarget) return
        const card = event.currentTarget
        if (open && !card.open && visible && card.contains(document.activeElement)) {
          const scroller = card.closest<HTMLElement>('.transcript')
          if (scroller) {
            const top = card.getBoundingClientRect().top - scroller.getBoundingClientRect().top
            if (top < 0 || top > scroller.clientHeight) scroller.scrollTop += top - 8
          }
        }
        setOpen(card.open)
      }}
    >
      <summary aria-label={`${name} skill, requested by you`}>
        <span className="skill-card-name">{name}</span>
        <span className="skill-card-trigger">Requested by you</span>
      </summary>
      <div className="skill-card-content">
        {result === null ? (
          <p role="status">Loading skill…</p>
        ) : result.kind === 'unavailable' ? (
          <div role="status">
            <p>
              {result.reason === 'not-allowed'
                ? 'This file is outside the allowed skill folders or its path is unsafe.'
                : result.reason === 'not-found'
                  ? 'This skill is no longer available in the recent conversation or at its local path.'
                  : 'Could not read this skill.'}
            </p>
            <button type="button" onClick={retry}>
              Try Again
            </button>
          </div>
        ) : (
          <>
            <p className="skill-card-origin">
              {result.source === 'conversation'
                ? 'From this conversation'
                : 'Current local version'}
            </p>
            {result.source === 'local' && (
              <p className="skill-card-note">This file may have changed since the conversation.</p>
            )}
            {result.description && <p className="skill-card-description">{result.description}</p>}
            {result.truncated && (
              <p className="truncation-notice">
                Skill content is limited. Open the skill in your editor to read the rest.
              </p>
            )}
            {result.text.trim() ? (
              <SafeMarkdown text={result.text} onLink={onLink} />
            ) : (
              <p>This skill has no body text.</p>
            )}
            {result.source === 'local' && (
              <button type="button" onClick={retry}>
                Reload Skill
              </button>
            )}
          </>
        )}
        <details className="skill-file-details">
          <summary>File details</summary>
          <code>{path}</code>
        </details>
      </div>
    </details>
  )
}
