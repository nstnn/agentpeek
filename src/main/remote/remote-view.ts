import { randomBytes } from 'node:crypto'
import type { SessionsSnapshot } from '../../core/snapshot'
import {
  NOTHING_SHARED,
  startRemoteListener,
  type RemoteListener,
  type RemoteSharing,
  type RemoteStartError
} from './listener'
import {
  checkConnection,
  isConfigured,
  loadRemoteSettings,
  saveRemoteSettings,
  type ConnectionField,
  type RemoteSettings
} from './settings'
import { MIN_SESSION_ID_SECRET_BYTES } from './session-ids'
import { loadViewerFiles } from './viewer-files'

// Remote View lifecycle (TASK-014): loads the saved settings, runs at most one listener, and turns
// it on, off and over to new connection settings. It is part of the open app, never a background
// process: AgentPeek's quit closes it with the sessions service. Settings UI is TASK-016.

export type RemoteViewError =
  /** Settings are still loading or could not be read; Remote View stays off. */
  | 'not-loaded'
  /** No valid login and Mac address are saved yet. */
  | 'not-configured'
  | 'save-failed'
  | RemoteStartError
  /** A later turn on, off, settings change or quit replaced this one. */
  | 'cancelled'

export type RemoteViewResult =
  | { ok: true }
  | { ok: false; error: RemoteViewError }
  | { ok: false; error: 'invalid'; invalid: ConnectionField[] }

export type RemoteViewStatus =
  | { state: 'loading' }
  | { state: 'load-failed' }
  | { state: 'off'; settings: RemoteSettings; startError: RemoteStartError | null }
  | { state: 'on'; settings: RemoteSettings; resumed: boolean; streams: number }

export interface RemoteViewOptions {
  /** The app state folder, which holds `remote-view.json`. */
  folder: string
  /** The viewer build output, `out/remote-web`. */
  viewerFolder: string
  snapshot: () => SessionsSnapshot
  /** What is shared. TASK-015 replaces the default, which shares no project. */
  sharing?: () => RemoteSharing
  now?: () => number
}

export type RemoteView = ReturnType<typeof createRemoteView>

export function createRemoteView(options: RemoteViewOptions) {
  const sharing = options.sharing ?? (() => NOTHING_SHARED)
  let loading = true
  /** Null while loading and after a load failure. */
  let settings: RemoteSettings | null = null
  let listener: RemoteListener | null = null
  let resumed = false
  let startError: RemoteStartError | null = null
  let generation = 0
  /** Bumped by every operation, so an older one in flight stops at its next step. */
  let epoch = 0
  let closing: Promise<void> | null = null
  let starts: Promise<unknown> = Promise.resolve()
  let saving: Promise<unknown> = Promise.resolve()

  /** Saves in call order; resolves false on failure. */
  function persist(next: RemoteSettings): Promise<boolean> {
    const saved = saving
      .then(() => saveRemoteSettings(options.folder, next))
      .then(
        () => true,
        () => false
      )
    saving = saved
    return saved
  }

  /**
   * Ends every stream and drops pending sends before anything is awaited. The new generation
   * means nothing projected for the old listener can be sent.
   */
  function stopListener(reason: 'remote-off' | 'access-changed' | 'shutdown'): Promise<void> {
    generation += 1
    const stopping = listener?.close(reason) ?? Promise.resolve()
    listener = null
    return stopping
  }

  /** Starts a listener for the saved settings, unless operation `op` was replaced meanwhile. */
  function listen(op: number): Promise<RemoteStartError | 'cancelled' | null> {
    const started = (async () => {
      const { port, ownerLogin, hostName } = settings!
      const viewer = await loadViewerFiles(options.viewerFolder)
      if (op !== epoch) return 'cancelled'
      const result = await startRemoteListener({
        port,
        access: { ownerLogin, hostName },
        // Never stored: a new listener, a new login or a relaunch makes old opaque IDs meaningless.
        secret: randomBytes(MIN_SESSION_ID_SECRET_BYTES),
        viewer,
        snapshot: options.snapshot,
        sharing,
        generation: () => generation,
        now: options.now
      })
      if (!result.ok) return op === epoch ? result.error : 'cancelled'
      if (op !== epoch) {
        await result.listener.close('remote-off')
        return 'cancelled'
      }
      listener = result.listener
      return null
    })()
    starts = Promise.allSettled([starts, started])
    return started
  }

  /** The switch shows off after a failed start, so a later launch must not turn it on alone. */
  function failStart(error: RemoteStartError): RemoteViewResult {
    startError = error
    settings = { ...settings!, enabled: false }
    void persist(settings)
    return { ok: false, error }
  }

  return {
    /** Reads the settings and, if Remote View was on at quit, turns it on again. */
    async open(): Promise<void> {
      const load = await loadRemoteSettings(options.folder)
      loading = false
      if (closing || !load.ok) return
      settings = load.settings
      if (!settings.enabled || !isConfigured(settings)) return
      const op = ++epoch
      const error = await listen(op)
      if (error === null) resumed = true
      else if (error !== 'cancelled') failStart(error)
    },

    /** Saves "on" first, then listens. */
    async enable(): Promise<RemoteViewResult> {
      if (closing) return { ok: false, error: 'cancelled' }
      if (!settings) return { ok: false, error: 'not-loaded' }
      if (!isConfigured(settings)) return { ok: false, error: 'not-configured' }
      if (listener) return { ok: true }
      const op = ++epoch
      startError = null
      const next = { ...settings, enabled: true }
      const saved = await persist(next)
      if (op !== epoch) return { ok: false, error: 'cancelled' }
      if (!saved) return { ok: false, error: 'save-failed' }
      settings = next
      resumed = false
      const error = await listen(op)
      if (error === null) return { ok: true }
      return error === 'cancelled' ? { ok: false, error } : failStart(error)
    },

    /**
     * Ends every stream and closes the listener at once, then saves "off". If saving fails it
     * stays off for this run and reports `save-failed`; it never turns back on because of it.
     */
    async disable(): Promise<RemoteViewResult> {
      if (closing) return { ok: false, error: 'cancelled' }
      epoch += 1
      const stopping = stopListener('remote-off')
      resumed = false
      startError = null
      if (!settings) {
        await stopping
        return { ok: true }
      }
      settings = { ...settings, enabled: false }
      const saved = await persist(settings)
      await stopping
      return saved ? { ok: true } : { ok: false, error: 'save-failed' }
    },

    /**
     * Validates and saves the login, Mac address and port. When on, a change ends every stream
     * with `access-changed` and listens again with the new values and a new ID secret.
     */
    async saveConnection(input: {
      ownerLogin: unknown
      hostName: unknown
      port: unknown
    }): Promise<RemoteViewResult> {
      if (closing) return { ok: false, error: 'cancelled' }
      if (!settings) return { ok: false, error: 'not-loaded' }
      const check = checkConnection(input)
      if (!check.ok) return { ok: false, error: 'invalid', invalid: check.invalid }
      const op = ++epoch
      const previous = settings
      const next = { ...previous, ...check.connection }
      const saved = await persist(next)
      if (op !== epoch) return { ok: false, error: 'cancelled' }
      if (!saved) return { ok: false, error: 'save-failed' }
      settings = next
      const changed =
        next.ownerLogin !== previous.ownerLogin ||
        next.hostName !== previous.hostName ||
        next.port !== previous.port
      if (!listener || !changed) return { ok: true }
      resumed = false
      await stopListener('access-changed')
      const error = await listen(op)
      if (error === null) return { ok: true }
      return error === 'cancelled' ? { ok: false, error } : failStart(error)
    },

    publish(snapshot: SessionsSnapshot): void {
      listener?.publish(snapshot)
    },

    status(): RemoteViewStatus {
      if (loading) return { state: 'loading' }
      if (!settings) return { state: 'load-failed' }
      return listener
        ? { state: 'on', settings: { ...settings }, resumed, streams: listener.streamCount() }
        : { state: 'off', settings: { ...settings }, startError }
    },

    /** Quit: ends every stream with `shutdown`, closes the listener and waits for saves. */
    close(): Promise<void> {
      closing ??= (async () => {
        epoch += 1
        const stopping = stopListener('shutdown')
        await Promise.allSettled([stopping, starts, saving])
      })()
      return closing
    }
  }
}
