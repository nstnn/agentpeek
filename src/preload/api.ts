import type { AgentPeekApi, AppSnapshot, MenuCommand } from '../shared/api'
import { IPC } from '../shared/ipc'
import type { RemoteStatusView } from '../shared/remote-settings'

/** The small part of ipcRenderer needed here; it is never exposed to the page. */
export interface PreloadTransport {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  on(channel: string, listener: (event: unknown, value: unknown) => void): unknown
  removeListener(channel: string, listener: (event: unknown, value: unknown) => void): unknown
}

export function createPreloadApi(transport: PreloadTransport): AgentPeekApi {
  const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> =>
    transport.invoke(channel, ...args) as Promise<T>
  function subscribe<T>(channel: string, callback: (value: T) => void): () => void {
    // The Electron event (and its sender) must never reach renderer code.
    const listener = (_event: unknown, value: unknown) => callback(value as T)
    transport.on(channel, listener)
    return () => {
      transport.removeListener(channel, listener)
    }
  }

  const api: AgentPeekApi = {
    getTheme: () => invoke(IPC.getTheme),
    setTheme: (theme) => invoke(IPC.setTheme, theme),
    setSourceEnabled: (tool, enabled) => invoke(IPC.setSourceEnabled, tool, enabled),
    getSnapshot: () => invoke(IPC.getSnapshot),
    onSnapshot: (callback: (snapshot: AppSnapshot) => void) => subscribe(IPC.snapshot, callback),
    getMessages: (key, limit) => invoke(IPC.getMessages, key, limit),
    getSkill: (key, request) => invoke(IPC.getSkill, key, request),
    setPinned: (key, pinned) => invoke(IPC.setPinned, key, pinned),
    markRead: (key, cursor) =>
      cursor === undefined ? invoke(IPC.markRead, key) : invoke(IPC.markRead, key, cursor),
    openTool: (key) => invoke(IPC.openTool, key),
    copySessionId: (key) => invoke(IPC.copySessionId, key),
    openLink: (url) => invoke(IPC.openLink, url),
    reload: () => invoke(IPC.reload),
    setSelection: (key, presentation) =>
      presentation === undefined
        ? invoke(IPC.setSelection, key)
        : invoke(IPC.setSelection, key, presentation),
    setDetailOpen: (open) => invoke(IPC.setDetailOpen, open),
    showSessionMenu: (key) => invoke(IPC.showSessionMenu, key),
    onCommand: (callback: (command: MenuCommand) => void) => subscribe(IPC.command, callback),
    getRemoteStatus: () => invoke(IPC.getRemoteStatus),
    onRemoteStatus: (callback: (status: RemoteStatusView) => void) =>
      subscribe(IPC.remoteStatus, callback),
    getRemoteAlias: (key) => invoke(IPC.getRemoteAlias, key),
    retryRemoteLoad: () => invoke(IPC.retryRemoteLoad),
    setRemoteEnabled: (enabled) => invoke(IPC.setRemoteEnabled, enabled),
    saveRemoteConnection: ({ ownerLogin, hostName, port }) =>
      invoke(IPC.saveRemoteConnection, { ownerLogin, hostName, port }),
    setRemoteWorkspaceShared: (workspace, shared) =>
      invoke(IPC.setRemoteWorkspaceShared, workspace, shared),
    setRemoteShareTitles: (shareTitles) => invoke(IPC.setRemoteShareTitles, shareTitles),
    setRemoteShareMessages: (shareMessages) => invoke(IPC.setRemoteShareMessages, shareMessages),
    copyRemoteText: (target) => invoke(IPC.copyRemoteText, target)
  }
  return Object.freeze(api)
}
