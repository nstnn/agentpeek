// What the desktop renderer sees of Remote View (TASK-016): the saved settings, whether the
// listener runs, and typed results of the settings actions. Folder paths appear here because the
// Settings dialog shows them on this Mac; they never leave it. Nothing here runs or reads Tailscale.

export interface RemoteSettingsView {
  readonly enabled: boolean
  /** Empty until the owner saves one. */
  readonly ownerLogin: string
  /** Empty until the owner saves one. */
  readonly hostName: string
  readonly port: number
  readonly sharedWorkspaces: readonly string[]
  readonly shareTitles: boolean
}

export type RemoteStartFailure = 'port-in-use' | 'start-failed'

interface RemoteRecoveryView {
  /** Effective settings differ from the last successful save. */
  readonly unsavedChanges?: true
  readonly pending?: true
  readonly requestedEnabled?: boolean
}

export type RemoteStatusView =
  | { readonly state: 'loading' }
  | { readonly state: 'load-failed' }
  | (RemoteRecoveryView & {
      readonly state: 'off'
      readonly settings: RemoteSettingsView
      /** Why the last start failed, until the next turn on, off or quit. */
      readonly startError: RemoteStartFailure | null
    })
  | (RemoteRecoveryView & {
      readonly state: 'on'
      readonly settings: RemoteSettingsView
      /** On because it was on when AgentPeek last quit. */
      readonly resumed: boolean
      /** Open viewer pages, a count only. */
      readonly streams: number
      /** "Share recent messages": held in the main process for this run only, never saved. */
      readonly shareMessages: boolean
    })

export type RemoteActionError =
  | 'not-loaded'
  | 'not-configured'
  | 'save-failed'
  | RemoteStartFailure
  | 'cancelled'
  | 'unknown-workspace'
  | 'too-many-workspaces'
  /** "Share recent messages" can be turned on only while Remote View is on. */
  | 'not-listening'

export type RemoteField = 'ownerLogin' | 'hostName' | 'port' | 'shareTitles' | 'shareMessages'

export type RemoteActionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: RemoteActionError; readonly connectionSaved?: boolean }
  | { readonly ok: false; readonly error: 'invalid'; readonly invalid: readonly RemoteField[] }

export interface RemoteConnectionInput {
  ownerLogin: string
  hostName: string
  port: number
}

/** The only texts the renderer can ask the main process to copy, built from saved settings. */
export const REMOTE_COPY_TARGETS = ['serve-command', 'viewer-address'] as const
export type RemoteCopyTarget = (typeof REMOTE_COPY_TARGETS)[number]

export function isRemoteCopyTarget(value: unknown): value is RemoteCopyTarget {
  return REMOTE_COPY_TARGETS.some((target) => target === value)
}

/** The owner runs this in Terminal; AgentPeek only shows and copies it. Never `funnel`. */
export function remoteServeCommand(port: number): string {
  return `tailscale serve --bg --https=443 http://127.0.0.1:${port}`
}

export function remoteViewerAddress(hostName: string): string {
  return `https://${hostName}/`
}
