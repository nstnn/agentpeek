import type { AgentPeekApi, AppSnapshot, MenuCommand } from '../shared/api'
import { IPC } from '../shared/ipc'

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
    openTool: (tool) => invoke(IPC.openTool, tool),
    copySessionId: (key) => invoke(IPC.copySessionId, key),
    openLink: (url) => invoke(IPC.openLink, url),
    reload: () => invoke(IPC.reload),
    setSelection: (key, presentation) =>
      presentation === undefined
        ? invoke(IPC.setSelection, key)
        : invoke(IPC.setSelection, key, presentation),
    setDetailOpen: (open) => invoke(IPC.setDetailOpen, open),
    showSessionMenu: (key) => invoke(IPC.showSessionMenu, key),
    onCommand: (callback: (command: MenuCommand) => void) => subscribe(IPC.command, callback)
  }
  return Object.freeze(api)
}
