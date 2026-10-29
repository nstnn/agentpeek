import { randomBytes } from 'node:crypto'
import {
  isListedWorkspace,
  isShareableWorkspace,
  MAX_SHARED_WORKSPACES,
  narrowsSharing,
  NOTHING_SHARED,
  sourceTurnedOff,
  type RemoteSharing
} from '../../core/remote/share-policy'
import type { SessionsSnapshot } from '../../core/snapshot'
import { startRemoteListener, type RemoteListener, type RemoteStartError } from './listener'
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
// process: AgentPeek's quit closes it with the sessions service. The Settings dialog reaches it
// through the typed IPC in `src/main/ipc.ts` (TASK-016).
//
// Sharing policy (TASK-015): the saved folders and title option are the only policy. The listener
// reads it, and the generation, when it projects each status, so nothing projected under an older
// policy is ever sent. Narrowing (a folder removed, titles off, a source turned off) applies before
// anything is awaited: the generation grows, pending sends are dropped and every stream gets a
// replacement status at once. Widening is saved first, like turning on.

export type RemoteViewError =
  /** Settings are still loading or could not be read; Remote View stays off. */
  | 'not-loaded'
  /** No valid login and Mac address are saved yet. */
  | 'not-configured'
  | 'save-failed'
  | RemoteStartError
  /** A later turn on, off, settings change or quit replaced this one. */
  | 'cancelled'
  /** The folder is not the exact folder of a session AgentPeek lists. */
  | 'unknown-workspace'
  /** Already sharing `MAX_SHARED_WORKSPACES` folders. */
  | 'too-many-workspaces'

export type RemoteViewResult =
  | { ok: true }
  | { ok: false; error: RemoteViewError }
  | { ok: false; error: 'invalid'; invalid: (ConnectionField | 'shareTitles')[] }

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
  now?: () => number
}

export type RemoteView = ReturnType<typeof createRemoteView>

type SettingsUpdate = (current: RemoteSettings) => RemoteSettings

export function createRemoteView(options: RemoteViewOptions) {
  let loading = true
  /** Null while loading and after a load failure. */
  let settings: RemoteSettings | null = null
  /** The policy the listener applies; a new frozen object on every change. */
  let sharing: RemoteSharing = NOTHING_SHARED
  /** The last snapshot handed over, to notice a source that was turned off. */
  let published = options.snapshot()
  let listener: RemoteListener | null = null
  /**
   * Whether this run should listen: set once "on" is saved or resumed, cleared by OFF, a failed
   * start and quit. `listener` is null for a moment while a start or a restart runs.
   */
  let listening = false
  let resumed = false
  let suspended = false
  let startError: RemoteStartError | null = null
  let generation = 0
  /** Bumped by every operation, so an older one in flight stops at its next step. */
  let epoch = 0
  let closing: Promise<void> | null = null
  let starts: Promise<unknown> = Promise.resolve()
  let saving: Promise<unknown> = Promise.resolve()

  /**
   * Saves in call order; resolves false on failure. Each save writes `update` of the settings in
   * memory when it runs, so it never undoes a change saved or narrowed meanwhile, and a change that
   * failed to save is never written by a later one.
   */
  function persist(update: SettingsUpdate = (current) => current): Promise<boolean> {
    const saved = saving
      .then(() => saveRemoteSettings(options.folder, update(settings!)))
      .then(
        () => true,
        () => false
      )
    saving = saved
    return saved
  }

  /**
   * Makes the saved sharing fields the policy. A new generation means no stream keeps a status
   * made under the old one: each gets a replacement now, ahead of coalescing.
   */
  function applySharing(): void {
    const { sharedWorkspaces, shareTitles } = settings!
    sharing = Object.freeze({ sharedWorkspaces: Object.freeze([...sharedWorkspaces]), shareTitles })
    generation += 1
    listener?.resync()
  }

  /**
   * Narrowing applies before the save and stays for this run if the save fails; widening applies
   * only once saved. `update` runs on the settings of the moment, so concurrent changes add up.
   */
  async function changeSharing(update: SettingsUpdate): Promise<RemoteViewResult> {
    if (narrowsSharing(settings!, update(settings!))) {
      settings = update(settings!)
      applySharing()
      return (await persist()) ? { ok: true } : { ok: false, error: 'save-failed' }
    }
    if (!(await persist(update))) return { ok: false, error: 'save-failed' }
    settings = update(settings!)
    applySharing()
    return { ok: true }
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
        sharing: () => sharing,
        generation: () => generation,
        now: options.now
      })
      if (!result.ok) return op === epoch ? result.error : 'cancelled'
      if (op !== epoch) {
        await result.listener.close('remote-off')
        return 'cancelled'
      }
      listener = result.listener
      if (suspended) listener.suspend()
      return null
    })()
    starts = Promise.allSettled([starts, started])
    return started
  }

  /** The switch shows off after a failed start, so a later launch must not turn it on alone. */
  function failStart(error: RemoteStartError): RemoteViewResult {
    startError = error
    listening = false
    settings = { ...settings!, enabled: false }
    void persist()
    return { ok: false, error }
  }

  /** Reads the settings and, if Remote View was on at quit, turns it on again. */
  async function open(): Promise<void> {
    const load = await loadRemoteSettings(options.folder)
    loading = false
    if (closing || !load.ok) return
    settings = load.settings
    applySharing()
    if (!settings.enabled || !isConfigured(settings)) return
    const op = ++epoch
    listening = true
    const error = await listen(op)
    if (error === null) resumed = true
    else if (error !== 'cancelled') failStart(error)
  }

  return {
    open,

    /** Try Again after a load failure: reads the file again, as at launch. Otherwise does nothing. */
    async retryLoad(): Promise<void> {
      if (closing || loading || settings) return
      loading = true
      await open()
    },

    /** Saves "on" first, then listens. */
    async enable(): Promise<RemoteViewResult> {
      if (closing) return { ok: false, error: 'cancelled' }
      if (!settings) return { ok: false, error: 'not-loaded' }
      if (!isConfigured(settings)) return { ok: false, error: 'not-configured' }
      if (listening) return { ok: true }
      const op = ++epoch
      startError = null
      const saved = await persist((current) => ({ ...current, enabled: true }))
      if (op !== epoch) return { ok: false, error: 'cancelled' }
      if (!saved) return { ok: false, error: 'save-failed' }
      settings = { ...settings, enabled: true }
      listening = true
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
      listening = false
      const stopping = stopListener('remote-off')
      resumed = false
      startError = null
      if (!settings) {
        await stopping
        return { ok: true }
      }
      settings = { ...settings, enabled: false }
      const saved = await persist()
      await stopping
      return saved ? { ok: true } : { ok: false, error: 'save-failed' }
    },

    /**
     * Validates and saves the login, Mac address and port. When on, a change ends every stream
     * with `access-changed` and drops pending sends before the save, so nothing queued for the old
     * login leaves meanwhile. It then listens again with a new ID secret: with the new values once
     * saved, or with the saved ones when the save fails, which changes nothing else.
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
      const { connection } = check
      const changed =
        connection.ownerLogin !== settings.ownerLogin ||
        connection.hostName !== settings.hostName ||
        connection.port !== settings.port
      // A start or an earlier restart still running has no listener yet, but must still listen.
      const restart = listening && (changed || listener === null)
      const stopping = restart ? stopListener('access-changed') : Promise.resolve()
      // Whatever an older operation was starting is closed again before this one listens.
      const earlier = starts
      if (restart) resumed = false
      const saved = await persist((current) => ({ ...current, ...connection }))
      // The file and memory agree even when a later operation replaced this one.
      if (saved) settings = { ...settings, ...connection }
      await Promise.all([stopping, earlier])
      if (op !== epoch) return { ok: false, error: 'cancelled' }
      // A start error was about the old values; the status must not repeat it with the new ones.
      if (saved && changed) startError = null
      if (!restart) return saved ? { ok: true } : { ok: false, error: 'save-failed' }
      const error = await listen(op)
      if (error !== null && error !== 'cancelled') failStart(error)
      if (!saved) return { ok: false, error: 'save-failed' }
      if (error === null) return { ok: true }
      return { ok: false, error }
    },

    /**
     * Shares one more exact folder. Only the folder of a session AgentPeek lists can be added, so
     * the policy never holds a path that came from anywhere else.
     */
    async shareWorkspace(workspace: unknown): Promise<RemoteViewResult> {
      if (closing) return { ok: false, error: 'cancelled' }
      if (!settings) return { ok: false, error: 'not-loaded' }
      if (!isShareableWorkspace(workspace) || !isListedWorkspace(options.snapshot(), workspace)) {
        return { ok: false, error: 'unknown-workspace' }
      }
      const full = (shared: readonly string[]) =>
        !shared.includes(workspace) && shared.length >= MAX_SHARED_WORKSPACES
      if (settings.sharedWorkspaces.includes(workspace)) return { ok: true }
      if (full(settings.sharedWorkspaces)) return { ok: false, error: 'too-many-workspaces' }
      // Checked again on the settings of the moment: other additions may have filled the list.
      let refused = false
      const result = await changeSharing((current) => {
        refused = full(current.sharedWorkspaces)
        return refused || current.sharedWorkspaces.includes(workspace)
          ? current
          : { ...current, sharedWorkspaces: [...current.sharedWorkspaces, workspace] }
      })
      return result.ok && refused ? { ok: false, error: 'too-many-workspaces' } : result
    },

    /**
     * Stops sharing a folder: its rows leave every stream before the change is saved. A folder
     * that is not shared is already in the requested state.
     */
    async unshareWorkspace(workspace: unknown): Promise<RemoteViewResult> {
      if (closing) return { ok: false, error: 'cancelled' }
      if (!settings) return { ok: false, error: 'not-loaded' }
      if (typeof workspace !== 'string') return { ok: false, error: 'unknown-workspace' }
      if (!settings.sharedWorkspaces.includes(workspace)) return { ok: true }
      return changeSharing((current) => ({
        ...current,
        sharedWorkspaces: current.sharedWorkspaces.filter((shared) => shared !== workspace)
      }))
    },

    /** Turning titles off replaces them with aliases on every stream before it is saved. */
    async setShareTitles(shareTitles: unknown): Promise<RemoteViewResult> {
      if (closing) return { ok: false, error: 'cancelled' }
      if (!settings) return { ok: false, error: 'not-loaded' }
      if (typeof shareTitles !== 'boolean') {
        return { ok: false, error: 'invalid', invalid: ['shareTitles'] }
      }
      if (settings.shareTitles === shareTitles) return { ok: true }
      return changeSharing((current) => ({ ...current, shareTitles }))
    },

    /** Hands a new snapshot to the listener. A source turned off is narrowing, like a folder. */
    publish(snapshot: SessionsSnapshot): void {
      const turnedOff = sourceTurnedOff(published, snapshot)
      published = snapshot
      if (turnedOff) generation += 1
      listener?.publish(snapshot)
      if (turnedOff) listener?.resync()
    },

    suspend(): void {
      suspended = true
      listener?.suspend()
    },

    resume(): void {
      suspended = false
      listener?.resume()
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
        listening = false
        const stopping = stopListener('shutdown')
        await Promise.allSettled([stopping, starts, saving])
      })()
      return closing
    }
  }
}
