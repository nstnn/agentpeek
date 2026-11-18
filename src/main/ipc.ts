import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'
import type { SessionKey } from '../core/session'
import { isAgentTool } from '../core/tools'
import { IPC, MAX_MESSAGE_LIMIT, MAX_REMOTE_TEXT_LENGTH } from '../shared/ipc'
import type { SessionController } from './session-controller'
import { isSessionRange, isTheme, type SessionRange } from '../shared/preferences'
import type { Preferences } from './preferences'
import type { SessionsService } from './sessions/service'
import { isSkillName, isSkillPath, type SkillRequest } from '../core/skills'
import { isShareableWorkspace } from '../core/remote/share-policy'
import {
  isRemoteCopyTarget,
  remoteServeCommand,
  remoteViewerAddress,
  type RemoteActionResult,
  type RemoteConnectionInput,
  type RemoteCopyTarget,
  type RemoteStatusView
} from '../shared/remote-settings'
import type { RemoteView } from './remote/remote-view'

/** Every request must come from this exact top-level frame at the expected app URL. */
export function isTrustedSender(
  event: IpcMainInvokeEvent,
  contents: WebContents,
  pageUrl: string
): boolean {
  return (
    !contents.isDestroyed() &&
    event.sender === contents &&
    event.senderFrame !== null &&
    event.senderFrame === contents.mainFrame &&
    event.senderFrame.url === pageUrl
  )
}

function isKey(value: unknown): value is SessionKey {
  if (typeof value !== 'object' || value === null) return false
  const key = value as Record<string, unknown>
  return (
    Object.keys(key).length === 2 &&
    Object.hasOwn(key, 'tool') &&
    Object.hasOwn(key, 'id') &&
    isAgentTool(key.tool) &&
    typeof key.id === 'string' &&
    key.id.length > 0 &&
    key.id.length <= 4096 &&
    !/\p{Cc}/u.test(key.id)
  )
}

function isWebLink(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 8192 || /[\s\p{Cc}]/u.test(value)) return false
  try {
    const url = new URL(value)
    return (
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      url.hostname !== '' &&
      !url.username &&
      !url.password
    )
  } catch {
    return false
  }
}

function isSkillRequest(value: unknown): value is SkillRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const request = value as Record<string, unknown>
  return (
    Object.keys(request).length === 3 &&
    Object.hasOwn(request, 'at') &&
    Object.hasOwn(request, 'name') &&
    Object.hasOwn(request, 'path') &&
    typeof request.at === 'number' &&
    Number.isSafeInteger(request.at) &&
    request.at >= 0 &&
    isSkillName(request.name) &&
    isSkillPath(request.path)
  )
}

/** Exactly `{ownerLogin, hostName, port}`: bounded strings and a number. `checkConnection` decides validity. */
function isConnectionInput(value: unknown): value is RemoteConnectionInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const input = value as Record<string, unknown>
  const text = (field: unknown) =>
    typeof field === 'string' && field.length <= MAX_REMOTE_TEXT_LENGTH
  return (
    Object.keys(input).length === 3 &&
    Object.hasOwn(input, 'ownerLogin') &&
    Object.hasOwn(input, 'hostName') &&
    Object.hasOwn(input, 'port') &&
    text(input.ownerLogin) &&
    text(input.hostName) &&
    typeof input.port === 'number'
  )
}

export type RemoteSettingsControl = Pick<
  RemoteView,
  | 'status'
  | 'aliasFor'
  | 'retryLoad'
  | 'enable'
  | 'disable'
  | 'saveConnection'
  | 'shareWorkspace'
  | 'unshareWorkspace'
  | 'setShareTitles'
  | 'setShareMessages'
>

/** No generic channels, Electron events, file-open capabilities or raw errors reach the renderer. */
export function registerSessionIpc(options: {
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>
  contents: WebContents
  pageUrl: string
  controller: SessionController
  preferences: Pick<Preferences, 'getTheme' | 'setTheme' | 'setSourceEnabled' | 'setSessionRange'>
  setSourceEnabled: SessionsService['setSourceEnabled']
  setSessionRange: SessionsService['setSessionRange']
  loadOlderSessions: SessionsService['loadOlder']
  remote: RemoteSettingsControl
  copyText: (text: string) => Promise<void>
}): () => void {
  const { ipc, controller: c } = options
  const channels: string[] = []
  const register = (
    channel: string,
    valid: (args: unknown[]) => boolean,
    call: (...args: never[]) => unknown
  ) => {
    ipc.handle(channel, async (event, ...args: unknown[]) => {
      if (!isTrustedSender(event, options.contents, options.pageUrl) || !valid(args)) {
        throw new Error('Invalid AgentPeek request.')
      }
      try {
        return await call(...(args as never[]))
      } catch {
        throw new Error('AgentPeek could not complete the request.')
      }
    })
    channels.push(channel)
  }
  const none = (args: unknown[]) => args.length === 0
  const key = (args: unknown[]) => args.length === 1 && isKey(args[0])
  register(IPC.getTheme, none, options.preferences.getTheme)
  register(
    IPC.setTheme,
    (args) => args.length === 1 && isTheme(args[0]),
    options.preferences.setTheme
  )
  register(IPC.getSnapshot, none, () => c.snapshot())
  register(
    IPC.setSourceEnabled,
    (args) => args.length === 2 && isAgentTool(args[0]) && typeof args[1] === 'boolean',
    async (tool, enabled) => {
      // Persist first: a failed save leaves the running source and UI unchanged.
      await options.preferences.setSourceEnabled(tool, enabled)
      await options.setSourceEnabled(tool, enabled)
    }
  )
  register(
    IPC.setSessionRange,
    (args) => args.length === 1 && isSessionRange(args[0]),
    async (range: SessionRange) => {
      // Persist first: a failed save leaves the listed range unchanged.
      const saved = { days: range.days, maxPerTool: range.maxPerTool }
      await options.preferences.setSessionRange(saved)
      await options.setSessionRange(saved)
    }
  )
  register(IPC.loadOlderSessions, none, options.loadOlderSessions)
  register(
    IPC.getMessages,
    (a) =>
      a.length === 2 &&
      isKey(a[0]) &&
      typeof a[1] === 'number' &&
      Number.isInteger(a[1]) &&
      a[1] >= 1 &&
      a[1] <= MAX_MESSAGE_LIMIT,
    c.getMessages
  )
  register(
    IPC.setPinned,
    (a) => a.length === 2 && isKey(a[0]) && typeof a[1] === 'boolean',
    c.setPinned
  )
  register(
    IPC.getSkill,
    (args) => args.length === 2 && isKey(args[0]) && isSkillRequest(args[1]),
    c.getSkill
  )
  register(
    IPC.markRead,
    (a) =>
      key(a) ||
      (a.length === 2 &&
        isKey(a[0]) &&
        typeof a[1] === 'string' &&
        a[1].length > 0 &&
        a[1].length <= 4096 &&
        !/\p{Cc}/u.test(a[1])),
    c.markRead
  )
  register(IPC.openTool, key, c.openTool)
  register(IPC.copySessionId, key, c.copySessionId)
  register(IPC.openLink, (a) => a.length === 1 && isWebLink(a[0]), c.openLink)
  register(IPC.reload, none, c.reload)
  register(
    IPC.setSelection,
    (a) =>
      (a.length === 1 ||
        (a.length === 2 &&
          typeof a[1] === 'object' &&
          a[1] !== null &&
          !Array.isArray(a[1]) &&
          Object.keys(a[1]).length === 1 &&
          Object.hasOwn(a[1], 'secondPaneOpen') &&
          typeof (a[1] as Record<string, unknown>).secondPaneOpen === 'boolean')) &&
      (a[0] === null || isKey(a[0])),
    c.setSelection
  )
  register(IPC.showSessionMenu, key, c.showSessionMenu)
  register(IPC.setDetailOpen, (a) => a.length === 1 && typeof a[0] === 'boolean', c.setDetailOpen)

  // Remote View settings (TASK-016): one handler per action, no method name from the page and
  // nothing that runs Tailscale. The listener keeps its own rules; these only check the shape.
  const { remote } = options
  const flag = (a: unknown[]) => a.length === 1 && typeof a[0] === 'boolean'
  register(IPC.getRemoteStatus, none, (): RemoteStatusView => remote.status())
  register(IPC.getRemoteAlias, key, (session: SessionKey): string | null =>
    remote.aliasFor(session)
  )
  register(IPC.retryRemoteLoad, none, (): Promise<void> => remote.retryLoad())
  register(IPC.setRemoteEnabled, flag, (enabled: boolean): Promise<RemoteActionResult> =>
    enabled ? remote.enable() : remote.disable()
  )
  register(
    IPC.saveRemoteConnection,
    (a) => a.length === 1 && isConnectionInput(a[0]),
    (connection: RemoteConnectionInput): Promise<RemoteActionResult> =>
      remote.saveConnection(connection)
  )
  register(
    IPC.setRemoteWorkspaceShared,
    (a) => a.length === 2 && isShareableWorkspace(a[0]) && typeof a[1] === 'boolean',
    (workspace: string, shared: boolean): Promise<RemoteActionResult> =>
      shared ? remote.shareWorkspace(workspace) : remote.unshareWorkspace(workspace)
  )
  register(IPC.setRemoteShareTitles, flag, (shareTitles: boolean): Promise<RemoteActionResult> =>
    remote.setShareTitles(shareTitles)
  )
  register(
    IPC.setRemoteShareMessages,
    flag,
    (shareMessages: boolean): Promise<RemoteActionResult> =>
      Promise.resolve(remote.setShareMessages(shareMessages))
  )
  register(
    IPC.copyRemoteText,
    (a) => a.length === 1 && isRemoteCopyTarget(a[0]),
    async (target: RemoteCopyTarget): Promise<boolean> => {
      const status = remote.status()
      if (status.state !== 'on' && status.state !== 'off') return false
      const { hostName, port } = status.settings
      if (target === 'viewer-address' && hostName === '') return false
      await options.copyText(
        target === 'serve-command' ? remoteServeCommand(port) : remoteViewerAddress(hostName)
      )
      return true
    }
  )
  return () => {
    for (const channel of channels) ipc.removeHandler(channel)
  }
}
