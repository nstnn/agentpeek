import { useCallback, useEffect, useId, useRef, useState, type JSX } from 'react'
import type { AgentPeekApi, AppSnapshot } from '../../shared/api'
import {
  remoteServeCommand,
  remoteViewerAddress,
  type RemoteActionResult,
  type RemoteCopyTarget,
  type RemoteField,
  type RemoteSettingsView,
  type RemoteStatusView
} from '../../shared/remote-settings'
import { candidateFolders, folderName } from './remote-folders'
import { statusLine, type Busy, type Notice } from './remote-status'

// The Remote View section of Settings (TASK-016, UX contract TASK-002 option A). The main process
// owns every rule: it validates the connection, checks each folder against the sessions it lists
// and decides what is sent. This section shows the saved state and the owner's Tailscale steps as
// text; AgentPeek never runs them.

interface Draft {
  ownerLogin: string
  hostName: string
  port: string
}

const INVALID_COPY: Record<'ownerLogin' | 'hostName' | 'port', string> = {
  ownerLogin: 'Enter a login like you@example.com.',
  hostName: 'Enter the full name ending in .ts.net.',
  port: 'Use a port from 1024 to 65535.'
}
const SAVED_NOTICE_MS = 3000
const COPIED_MS = 2000
const LOADING_RETRY_MS = 500

function draftOf(settings: RemoteSettingsView): Draft {
  return {
    ownerLogin: settings.ownerLogin,
    hostName: settings.hostName,
    port: String(settings.port)
  }
}

export function RemoteViewSettings({
  api,
  snapshot
}: {
  api: AgentPeekApi
  snapshot: AppSnapshot | null
}): JSX.Element {
  const id = useId()
  const mounted = useRef(true)
  const [status, setStatus] = useState<RemoteStatusView | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [invalid, setInvalid] = useState<readonly RemoteField[]>([])
  const [busy, setBusy] = useState<Busy | null>(null)
  const [switchNotice, setSwitchNotice] = useState<Notice | null>(null)
  const [connectionNotice, setConnectionNotice] = useState<Notice | null>(null)
  const [sharingNotice, setSharingNotice] = useState<Notice | null>(null)
  const [titlesNotice, setTitlesNotice] = useState<Notice | null>(null)
  const [messagesNotice, setMessagesNotice] = useState<Notice | null>(null)
  const [picking, setPicking] = useState(false)
  const [copied, setCopied] = useState<{ target: RemoteCopyTarget; ok: boolean } | null>(null)
  const running = useRef(false)
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>())

  const later = useCallback((ms: number, run: () => void) => {
    const timer = setTimeout(() => {
      timers.current.delete(timer)
      if (mounted.current) run()
    }, ms)
    timers.current.add(timer)
  }, [])

  const refresh = useCallback(async (): Promise<RemoteStatusView | null> => {
    try {
      const next = await api.getRemoteStatus()
      if (mounted.current) setStatus(next)
      return next
    } catch {
      if (mounted.current) setStatus({ state: 'load-failed' })
      return null
    }
  }, [api])

  useEffect(() => {
    mounted.current = true
    const pending = timers.current
    return () => {
      mounted.current = false
      for (const timer of pending) clearTimeout(timer)
      pending.clear()
    }
  }, [])
  // Every status change the main process announces, viewer page counts included (TASK-042).
  useEffect(
    () =>
      api.onRemoteStatus((next) => {
        if (mounted.current) setStatus(next)
      }),
    [api]
  )
  // Snapshots arrive on change, so resumed state stays close to current.
  useEffect(() => {
    let active = true
    void api.getRemoteStatus().then(
      (next) => {
        if (active) setStatus(next)
      },
      () => {
        if (active) setStatus({ state: 'load-failed' })
      }
    )
    return () => {
      active = false
    }
  }, [api, snapshot])
  // Settings load once at launch; a dialog opened before that asks again shortly.
  const stillLoading =
    status?.state === 'loading' || (status && 'pending' in status && status.pending)
  useEffect(() => {
    if (stillLoading) later(LOADING_RETRY_MS, () => void refresh())
  }, [stillLoading, status, later, refresh])

  const settings = status?.state === 'on' || status?.state === 'off' ? status.settings : null
  const saved = settings ? draftOf(settings) : null
  // The form follows the saved values until the owner edits a field.
  const form = draft ?? saved
  const dirty =
    form !== null &&
    saved !== null &&
    (form.ownerLogin !== saved.ownerLogin ||
      form.hostName !== saved.hostName ||
      form.port !== saved.port)
  const configured = settings !== null && settings.ownerLogin !== '' && settings.hostName !== ''
  const on =
    status?.state === 'on' ||
    (status !== null && 'requestedEnabled' in status && status.requestedEnabled === true)
  const unsaved = status && 'unsavedChanges' in status && status.unsavedChanges

  /** One action at a time; a second one while busy is reported as cancelled, which shows nothing. */
  async function run(
    kind: Busy,
    action: () => Promise<RemoteActionResult>
  ): Promise<RemoteActionResult | null> {
    if (running.current) return { ok: false, error: 'cancelled' }
    running.current = true
    setBusy(kind)
    let result: RemoteActionResult | null
    try {
      result = await action()
    } catch {
      result = null
    }
    await refresh()
    running.current = false
    if (mounted.current) setBusy(null)
    return result
  }

  async function toggle() {
    if (!configured) return
    const enabling = !on
    setSwitchNotice(null)
    const result = await run(enabling ? 'enabling' : 'disabling', () =>
      api.setRemoteEnabled(enabling)
    )
    if (!mounted.current || result?.ok) return
    if (result && (result.error === 'port-in-use' || result.error === 'start-failed')) return
    if (result?.error === 'cancelled') return
    setSwitchNotice(
      enabling
        ? { tone: 'error', text: "Couldn't turn on Remote View. It stays off. Try again." }
        : {
            tone: 'warning',
            text: "Remote View is off for now, but the setting couldn't be saved. It may turn on again next time AgentPeek opens."
          }
    )
  }

  async function save() {
    if (!form || !dirty) return
    const port = /^\d{1,5}$/.test(form.port.trim()) ? Number(form.port.trim()) : Number.NaN
    setConnectionNotice(null)
    setSwitchNotice(null)
    const wasOn = on
    const result = await run('saving', () =>
      api.saveRemoteConnection({ ownerLogin: form.ownerLogin, hostName: form.hostName, port })
    )
    if (!mounted.current) return
    if (result?.ok) {
      setInvalid([])
      setDraft(null)
      const saved: Notice = {
        tone: 'info',
        text: wasOn ? 'Saved. Open viewer pages reconnect with the new settings.' : 'Saved.'
      }
      setConnectionNotice(saved)
      // Clears only this notice: a later save or error keeps its own.
      later(SAVED_NOTICE_MS, () => setConnectionNotice((shown) => (shown === saved ? null : shown)))
    } else if (result && 'connectionSaved' in result && result.connectionSaved) {
      setInvalid([])
      setDraft(null)
      setConnectionNotice({
        tone: 'error',
        text: 'Connection settings saved. Remote View is now off because it could not restart. Resolve the start error above, then turn it on again.'
      })
    } else if (result && result.error === 'invalid') {
      setInvalid(result.invalid)
    } else if (result?.error !== 'cancelled') {
      setConnectionNotice({
        tone: 'error',
        text: "Couldn't save connection settings. Previous connection settings are kept. Check the Remote View status above and try again."
      })
    }
  }

  function cancel() {
    setDraft(null)
    setInvalid([])
    setConnectionNotice(null)
  }

  async function share(folder: string, shared: boolean) {
    setSharingNotice(null)
    const result = await run('sharing', () => api.setRemoteWorkspaceShared(folder, shared))
    if (!mounted.current) return
    if (result?.ok) {
      setPicking(false)
      return
    }
    if (result?.error === 'cancelled') return
    setSharingNotice({
      tone: 'error',
      text:
        result?.error === 'too-many-workspaces'
          ? 'You can share up to 50 projects. Remove one first.'
          : "Couldn't update shared projects. Try again."
    })
  }

  async function setTitles(shareTitles: boolean) {
    setTitlesNotice(null)
    const result = await run('titles', () => api.setRemoteShareTitles(shareTitles))
    if (!mounted.current) return
    if (result?.ok)
      setTitlesNotice({
        tone: 'info',
        text: shareTitles
          ? 'Titles are shared.'
          : "Titles are hidden; sessions show as 'Session N'."
      })
    else if (result?.error !== 'cancelled')
      setTitlesNotice({ tone: 'error', text: "Couldn't update title sharing. Try again." })
  }

  async function setMessages(shareMessages: boolean) {
    setMessagesNotice(null)
    const result = await run('messages', () => api.setRemoteShareMessages(shareMessages))
    if (!mounted.current) return
    if (result?.ok)
      setMessagesNotice({
        tone: shareMessages ? 'warning' : 'info',
        text: shareMessages
          ? 'Recent messages are shared until you turn this off, turn Remote View off or quit AgentPeek.'
          : 'Recent messages are no longer shared.'
      })
    else if (result?.error === 'not-listening')
      setMessagesNotice({ tone: 'error', text: 'Turn on Remote View first.' })
    else if (result?.error !== 'cancelled')
      setMessagesNotice({ tone: 'error', text: "Couldn't update message sharing. Try again." })
  }

  async function retrySaving() {
    if (!settings) return
    const result = await run('retrying', () => api.setRemoteShareTitles(settings.shareTitles))
    if (mounted.current && result?.ok) {
      setSwitchNotice(null)
      setSharingNotice(null)
      setTitlesNotice(null)
    }
  }

  async function copy(target: RemoteCopyTarget) {
    let ok: boolean
    try {
      ok = await api.copyRemoteText(target)
    } catch {
      ok = false
    }
    if (!mounted.current) return
    const shown = { target, ok }
    setCopied(shown)
    later(COPIED_MS, () => setCopied((current) => (current === shown ? null : current)))
  }

  const line = statusLine(status, busy)
  const listening = status?.state === 'on'
  const sharesMessages = status?.state === 'on' && status.shareMessages
  const shared = settings?.sharedWorkspaces ?? []
  const candidates = picking ? candidateFolders(snapshot, shared) : []
  const field = (name: 'ownerLogin' | 'hostName' | 'port') => ({
    id: `${id}-${name}`,
    value: form?.[name] ?? '',
    readOnly: busy === 'saving',
    disabled: form === null,
    'aria-invalid': invalid.includes(name),
    'aria-describedby': `${id}-${name}-hint`,
    autoComplete: 'off',
    spellCheck: false,
    onChange: (event: { currentTarget: HTMLInputElement }) => {
      const value = event.currentTarget.value
      setDraft({ ...(form ?? { ownerLogin: '', hostName: '', port: '' }), [name]: value })
      setInvalid((fields) => fields.filter((other) => other !== name))
    }
  })
  const hint = (name: 'ownerLogin' | 'hostName' | 'port', text: string) => (
    <p id={`${id}-${name}-hint`} className={invalid.includes(name) ? 'settings-error' : ''}>
      {invalid.includes(name) ? INVALID_COPY[name] : text}
    </p>
  )
  const copyLabel = (target: RemoteCopyTarget) =>
    copied?.target === target ? (copied.ok ? 'Copied' : "Couldn't copy") : 'Copy'
  const port = settings?.port
  const address = settings?.hostName ? remoteViewerAddress(settings.hostName) : null
  const notice = (value: Notice | null) =>
    value && (
      <p
        className={`remote-notice remote-${value.tone}`}
        role={value.tone === 'info' ? undefined : 'alert'}
        aria-live={value.tone === 'info' ? 'polite' : undefined}
      >
        {value.text}
      </p>
    )

  return (
    <section className="settings-body settings-remote" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>Remote View</h2>
      <div className="settings-source">
        <div>
          <label id={`${id}-switch-name`} htmlFor={`${id}-switch`}>
            Remote View
          </label>
          <p
            id={`${id}-status`}
            className={
              line.tone === 'error' ? 'settings-error remote-status' : 'settings-source-status'
            }
            aria-live="polite"
          >
            {line.text}
          </p>
        </div>
        <button
          id={`${id}-switch`}
          type="button"
          role="switch"
          className="source-switch"
          aria-checked={busy === 'enabling' || (on && busy !== 'disabling')}
          aria-describedby={`${id}-status`}
          disabled={!configured}
          aria-disabled={busy !== null}
          onClick={() => void toggle()}
        >
          <span aria-hidden="true" />
        </button>
      </div>
      {status?.state === 'load-failed' && (
        <div className="settings-error" role="alert">
          <button
            type="button"
            onClick={() => {
              setStatus(null)
              void api
                .retryRemoteLoad()
                .catch(() => undefined)
                .then(refresh)
            }}
          >
            Try Again
          </button>
        </div>
      )}
      {notice(switchNotice)}
      {unsaved && (
        <div className="remote-notice remote-warning" role="alert">
          <p>
            Some Remote View changes are not saved. They apply for now, but previously saved sharing
            settings may return next time AgentPeek opens.
          </p>
          <button type="button" disabled={busy !== null} onClick={() => void retrySaving()}>
            Retry saving Remote View settings
          </button>
        </div>
      )}

      <form
        className="remote-group"
        aria-labelledby={`${id}-connection`}
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          void save()
        }}
      >
        <h3 id={`${id}-connection`}>Connection</h3>
        <div className="remote-field">
          <label htmlFor={`${id}-ownerLogin`}>Tailscale login</label>
          <input type="text" placeholder="you@example.com" {...field('ownerLogin')} />
          {hint('ownerLogin', 'Only this login can open the page.')}
        </div>
        <div className="remote-field">
          <label htmlFor={`${id}-hostName`}>Mac address</label>
          <input type="text" placeholder="mac-name.tailnet-name.ts.net" {...field('hostName')} />
          {hint('hostName', 'From the Tailscale app → this Mac → Machine name. HTTPS must be on.')}
        </div>
        <div className="remote-field">
          <label htmlFor={`${id}-port`}>Port</label>
          <input type="text" inputMode="numeric" className="remote-port" {...field('port')} />
          {hint('port', 'Local port that tailscale serve forwards to.')}
        </div>
        {dirty && (
          <div className="remote-actions">
            <p className="settings-source-status" aria-live="polite">
              {busy === 'saving' ? 'Saving…' : 'Unsaved changes.'}
            </p>
            <button type="button" onClick={cancel} disabled={busy === 'saving'}>
              Cancel
            </button>
            <button type="submit" aria-disabled={busy !== null}>
              Save
            </button>
          </div>
        )}
        {notice(connectionNotice)}
        {address && (
          <p className="remote-copy-line">
            <span>
              Viewer address: <code>{address}</code>
            </span>
            <button type="button" onClick={() => void copy('viewer-address')}>
              {copyLabel('viewer-address')}
            </button>
          </p>
        )}
      </form>

      <div className="remote-group" role="group" aria-labelledby={`${id}-projects`}>
        <h3 id={`${id}-projects`}>Shared projects</h3>
        {shared.length === 0 ? (
          <p className="settings-source-status">No projects shared.</p>
        ) : (
          <ul className="remote-projects">
            {shared.map((folder) => (
              <li key={folder}>
                <span title={folder}>{folderName(folder)}</span>
                <button
                  type="button"
                  aria-label={`Remove ${folderName(folder)}`}
                  aria-disabled={busy !== null}
                  onClick={() => void share(folder, false)}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <button
          type="button"
          aria-expanded={picking}
          aria-controls={`${id}-candidates`}
          disabled={settings === null}
          onClick={() => setPicking((open) => !open)}
        >
          Add Project…
        </button>
        {picking && (
          <div id={`${id}-candidates`}>
            {candidates.length === 0 ? (
              <p className="settings-source-status">
                No other project folders. A folder appears here once AgentPeek lists a session in
                it.
              </p>
            ) : (
              <ul className="remote-candidates" aria-label="Project folders">
                {candidates.map((folder) => (
                  <li key={folder}>
                    <button
                      type="button"
                      aria-disabled={busy !== null}
                      onClick={() => void share(folder, true)}
                    >
                      <span>{folderName(folder)}</span>
                      <span className="remote-parent">
                        {folder.slice(0, folder.length - folderName(folder).length)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <p className="settings-source-status">
          Only these folders are shared, not their subfolders or worktrees.
        </p>
        {notice(sharingNotice)}
      </div>

      <div className="remote-group">
        <div className="settings-source">
          <div>
            <label htmlFor={`${id}-titles`}>Share session titles</label>
            <p id={`${id}-titles-hint`} className="settings-source-status">
              Titles come from your conversations and may contain code names, customers or file
              names. When off, sessions show as &lsquo;Session 3&rsquo;.
            </p>
          </div>
          <button
            id={`${id}-titles`}
            type="button"
            role="switch"
            className="source-switch"
            aria-checked={settings?.shareTitles ?? false}
            aria-describedby={`${id}-titles-hint`}
            disabled={settings === null}
            aria-disabled={busy !== null}
            onClick={() => void setTitles(!(settings?.shareTitles ?? false))}
          >
            <span aria-hidden="true" />
          </button>
        </div>
        {notice(titlesNotice)}
      </div>

      <div className="remote-group">
        <div className="settings-source">
          <div>
            <label htmlFor={`${id}-messages`}>Share recent messages</label>
            <p id={`${id}-messages-hint`} className="settings-source-status">
              While this is on, conversation text leaves this Mac: a viewer page can show the latest
              20 prompts and replies (up to 64 KB of text) of a session in a shared project. Never
              full history, files, tool input or output, or paths. Turns off when you quit
              AgentPeek, turn Remote View off or change the connection settings.
              {!listening && ' Turn on Remote View to use it.'}
            </p>
          </div>
          <button
            id={`${id}-messages`}
            type="button"
            role="switch"
            className="source-switch"
            aria-checked={sharesMessages}
            aria-describedby={`${id}-messages-hint`}
            disabled={!listening}
            aria-disabled={busy !== null}
            onClick={() => void setMessages(!sharesMessages)}
          >
            <span aria-hidden="true" />
          </button>
        </div>
        {notice(messagesNotice)}
      </div>

      <div className="remote-group" role="group" aria-labelledby={`${id}-leaves`}>
        <h3 id={`${id}-leaves`}>What leaves this Mac</h3>
        <ul className="remote-list">
          <li>The folder name of each shared project, never its path.</li>
          <li>
            For each session in a shared project: Codex or Claude Code, its status, and how long it
            has been in that state or when it was last active.
          </li>
          <li>Session titles only when Share session titles is on.</li>
          <li>
            Recent messages only while Share recent messages is on: the latest 20 prompts and
            replies of a session in a shared project, with the number of tool calls in each reply.
          </li>
          <li>Whether each tool is connected, and when AgentPeek last read its files.</li>
        </ul>
        <p className="settings-source-status">
          Never sent: full conversation history, files, tool names, input or output, file paths,
          session IDs, tool versions, or sessions in folders you don&rsquo;t share. With Share
          recent messages off, no message or reply text is sent.
        </p>
      </div>

      <details className="remote-group remote-setup">
        <summary>Set up Tailscale</summary>
        <p className="settings-source-status">
          AgentPeek never runs these steps or changes Tailscale. Do them yourself.
        </p>
        <ol className="remote-list">
          <li>
            Install Tailscale on this Mac and on each device you want to view from, and sign in with
            the same account on all of them. Turn on two-factor sign-in with your login provider.
          </li>
          <li>
            In the Tailscale admin console, turn on Tailnet Lock, so no new device can join without
            a signature from one of yours.
          </li>
          <li>
            Give this Mac a neutral machine name (for example <code>mac-01</code>). The name becomes
            public in certificate logs once HTTPS is on, so do this first.
          </li>
          <li>In the admin console, turn on HTTPS certificates (DNS → HTTPS Certificates).</li>
          <li>
            Above, enter your Tailscale login and this Mac&rsquo;s address (
            <code>&lt;machine&gt;.&lt;tailnet&gt;.ts.net</code>), keep or change the port, Save, add
            the projects to share and turn Remote View on.
          </li>
          <li>
            In Terminal on this Mac, run:
            <span className="remote-copy-line">
              <code>
                {port === undefined
                  ? 'tailscale serve --bg --https=443 http://127.0.0.1:<port>'
                  : remoteServeCommand(port)}
              </code>
              <button
                type="button"
                disabled={port === undefined}
                onClick={() => void copy('serve-command')}
              >
                {copyLabel('serve-command')}
              </button>
            </span>
            Never use <code>tailscale funnel</code> for this port; Funnel makes it public.
          </li>
          <li>
            On your phone, with Tailscale connected, open{' '}
            <code>{address ?? 'https://<machine>.<tailnet>.ts.net/'}</code>. If you see a Tailscale
            error page instead of AgentPeek, AgentPeek is closed or the Mac is asleep or offline.
            AgentPeek must be open on the Mac to view.
          </li>
        </ol>
        <p className="settings-source-status">
          To stop: turn Remote View off here. Optionally also run <code>tailscale serve reset</code>
          . Either one alone stops remote viewing. To stop one device from viewing, remove it from
          your tailnet in the Tailscale admin console, or change your tailnet&rsquo;s access
          controls (ACLs) so it can&rsquo;t reach this Mac. Neither takes back what a device already
          showed or what was copied from it.
        </p>
      </details>
    </section>
  )
}
