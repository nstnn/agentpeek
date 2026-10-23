import { useEffect, useId, useLayoutEffect, useRef, useState, type JSX } from 'react'
import type { AgentPeekApi } from '../../shared/api'
import { THEMES, type Theme } from '../../shared/preferences'

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
  onClose
}: {
  api: AgentPeekApi
  onClose: () => void
}): JSX.Element {
  const id = useId()
  const dialog = useRef<HTMLDialogElement>(null)
  const mounted = useRef(false)
  const [theme, setTheme] = useState<Theme | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)

  useLayoutEffect(() => {
    mounted.current = true
    const element = dialog.current!
    element.showModal()
    return () => {
      mounted.current = false
      element.close()
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
    </dialog>
  )
}
