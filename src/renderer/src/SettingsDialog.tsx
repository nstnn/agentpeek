import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode
} from 'react'
import type { AgentPeekApi, AppSnapshot } from '../../shared/api'
import {
  SESSION_DAYS,
  SESSIONS_PER_TOOL,
  THEMES,
  type SessionRange,
  type Theme
} from '../../shared/preferences'
import { AGENT_TOOLS, type AgentTool } from '../../core/tools'
import { healthCopy, rangeDays, toolName } from './session-display'
import { RemoteViewSettings } from './RemoteViewSettings'
import { SettingsSelect } from './SettingsSelect'

const LABELS = { system: 'System', light: 'Light', dark: 'Dark' }

export function SettingsIcon(): JSX.Element {
  return (
    <svg className="navigation-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="m9.5 3-.6 2.2-1.7 1-2.2-.6-2.5 4.3 1.6 1.6v2L2.5 15.1 5 19.4l2.2-.6 1.7 1 .6 2.2h5l.6-2.2 1.7-1 2.2.6 2.5-4.3-1.6-1.6v-2l1.6-1.6L19 5.6l-2.2.6-1.7-1L14.5 3z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12.5" r="3.25" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}

export function SettingsDialog({
  api,
  snapshot,
  onClose,
  feedback
}: {
  api: AgentPeekApi
  snapshot: AppSnapshot | null
  onClose: () => void
  feedback?: ReactNode
}): JSX.Element {
  const id = useId()
  const dialog = useRef<HTMLDialogElement>(null)
  const mounted = useRef(false)
  const [theme, setTheme] = useState<Theme | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const [savingSource, setSavingSource] = useState<AgentTool | null>(null)
  const [sourceError, setSourceError] = useState<string | null>(null)

  useLayoutEffect(() => {
    mounted.current = true
    const element = dialog.current!
    const trigger = document.activeElement
    element.showModal()
    return () => {
      mounted.current = false
      element.close()
      if (!trigger?.isConnected)
        document
          .querySelector<HTMLButtonElement>('.sidebar-settings')
          ?.focus({ preventScroll: true })
    }
  }, [])
  useEffect(() => {
    let active = true
    void api.getTheme().then(
      (value) => {
        if (!active) return
        setTheme(value)
        setLoading(false)
      },
      () => {
        if (!active) return
        setError("Couldn't load appearance settings.")
        setLoading(false)
      }
    )
    return () => {
      active = false
    }
  }, [api, retry])

  const choose = async (next: Theme) => {
    if (theme === null || saving || next === theme) return
    const previous = theme
    setTheme(next)
    setSaving(true)
    setError(null)
    try {
      await api.setTheme(next)
    } catch {
      if (mounted.current) {
        setTheme(previous)
        setError("Couldn't save theme. Your previous appearance has been restored. Try again.")
      }
    } finally {
      if (mounted.current) setSaving(false)
    }
  }

  const toggleSource = async (tool: AgentTool, enabled: boolean) => {
    if (savingSource !== null) return
    setSavingSource(tool)
    setSourceError(null)
    try {
      await api.setSourceEnabled(tool, enabled)
    } catch {
      if (mounted.current)
        setSourceError(`Couldn't update ${toolName(tool)} monitoring. Try again.`)
    } finally {
      if (mounted.current) setSavingSource(null)
    }
  }

  return (
    <dialog
      ref={dialog}
      className="settings-dialog"
      aria-labelledby={`${id}-title`}
      aria-modal="true"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      <header className="settings-header">
        <h1 id={`${id}-title`}>Settings</h1>
        <button
          type="button"
          className="settings-close"
          aria-label="Close Settings"
          title="Close Settings (Esc)"
          autoFocus
          onClick={onClose}
        >
          <span aria-hidden="true">×</span>
        </button>
      </header>
      <section className="settings-body" aria-labelledby={`${id}-appearance`}>
        <h2 id={`${id}-appearance`}>Appearance</h2>
        <fieldset
          className="theme-fieldset"
          disabled={loading || theme === null}
          aria-busy={saving}
        >
          <legend>Theme</legend>
          <div className="theme-options">
            {THEMES.map((value) => (
              <label key={value} className="theme-option" data-selected={theme === value}>
                <span className={`theme-preview theme-preview-${value}`} aria-hidden="true">
                  <span className="theme-preview-sidebar" />
                  <span className="theme-preview-content">
                    <span />
                    <span />
                    <span />
                  </span>
                </span>
                <span className="theme-option-label">
                  <input
                    type="radio"
                    name={`${id}-theme`}
                    value={value}
                    checked={theme === value}
                    onChange={() => void choose(value)}
                  />
                  {LABELS[value]}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <p className="settings-hint" aria-live="polite">
          {loading
            ? 'Loading appearance…'
            : saving
              ? 'Saving appearance…'
              : theme === 'system'
                ? 'Follows your Mac’s appearance. Changes are saved automatically.'
                : 'Changes apply immediately and are saved automatically.'}
        </p>
        {error && (
          <div className="settings-error" role="alert">
            <p>{error}</p>
            {theme === null && (
              <button
                type="button"
                onClick={() => {
                  setError(null)
                  setLoading(true)
                  setRetry((value) => value + 1)
                }}
              >
                Try Again
              </button>
            )}
          </div>
        )}
      </section>
      <section className="settings-body settings-sources" aria-labelledby={`${id}-sources`}>
        <h2 id={`${id}-sources`}>Sources</h2>
        <p className="settings-hint">Choose which tools AgentPeek monitors on this Mac.</p>
        {AGENT_TOOLS.map((tool) => {
          const health = snapshot?.health[tool]
          const enabled = health !== undefined && health.state !== 'off'
          return (
            <div className="settings-source" key={tool}>
              <div>
                <label id={`${id}-${tool}-name`} htmlFor={`${id}-${tool}`}>
                  {toolName(tool)}
                </label>
                <p
                  id={`${id}-${tool}-status`}
                  className="settings-source-status"
                  aria-live="polite"
                >
                  {savingSource === tool
                    ? 'Saving…'
                    : health
                      ? healthCopy(tool, health).label
                      : 'Loading…'}
                </p>
                {tool === 'antigravity' && (
                  <p className="settings-source-note">
                    Lists Desktop conversations with transcripts only (excludes older legacy
                    sessions). Shows Running, Idle, Unknown, and new replies.
                  </p>
                )}
              </div>
              <button
                id={`${id}-${tool}`}
                type="button"
                role="switch"
                className="source-switch"
                aria-label={`Monitor ${toolName(tool)}`}
                aria-describedby={`${id}-${tool}-status`}
                aria-checked={enabled}
                disabled={!snapshot}
                aria-disabled={savingSource !== null}
                onClick={() => void toggleSource(tool, !enabled)}
              >
                <span aria-hidden="true" />
              </button>
            </div>
          )
        })}
        {sourceError && (
          <p className="settings-error" role="alert">
            {sourceError}
          </p>
        )}
      </section>
      <SessionHistorySettings api={api} snapshot={snapshot} />
      <RemoteViewSettings api={api} snapshot={snapshot} />
      {feedback}
    </dialog>
  )
}

/** Settings > Session history (REQ-002): how far back the list reaches, and how many per tool. */
function SessionHistorySettings({
  api,
  snapshot
}: {
  api: AgentPeekApi
  snapshot: AppSnapshot | null
}): JSX.Element {
  const id = useId()
  const mounted = useRef(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useLayoutEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const saved: SessionRange | null = snapshot
    ? { days: snapshot.range.savedDays, maxPerTool: snapshot.range.savedMaxPerTool }
    : null
  const save = async (next: SessionRange) => {
    if (saving) return
    setSaving(true)
    setError(null)
    try {
      await api.setSessionRange(next)
    } catch {
      if (mounted.current) setError("Couldn't save session history. Try again.")
    } finally {
      if (mounted.current) setSaving(false)
    }
  }
  return (
    <section className="settings-body settings-sources" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>Session history</h2>
      <div className="settings-source">
        <span id={`${id}-days`} className="settings-select-label">
          Show sessions active in the last
        </span>
        <SettingsSelect
          labelId={`${id}-days`}
          value={saved?.days ?? null}
          options={SESSION_DAYS.map((days) => ({ value: days, label: rangeDays(days) }))}
          disabled={!saved || saving}
          onChange={(days) => {
            if (saved) void save({ ...saved, days })
          }}
        />
      </div>
      <div className="settings-source">
        <span id={`${id}-count`} className="settings-select-label">
          At most, per tool
        </span>
        <SettingsSelect
          labelId={`${id}-count`}
          value={saved?.maxPerTool ?? null}
          options={SESSIONS_PER_TOOL.map((count) => ({ value: count, label: `${count} sessions` }))}
          disabled={!saved || saving}
          onChange={(maxPerTool) => {
            if (saved) void save({ ...saved, maxPerTool })
          }}
        />
      </div>
      <p className="settings-hint" aria-live="polite">
        {saving
          ? 'Saving…'
          : 'Pinned and open Claude Code sessions always show. Longer ranges read more files and can make refreshes slower.'}
      </p>
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
