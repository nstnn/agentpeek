import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'
import type { SessionKey } from '../core/session'
import { isAgentTool } from '../core/tools'
import { IPC, MAX_MESSAGE_LIMIT } from '../shared/ipc'
import type { SessionController } from './session-controller'

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

/** No generic channels, Electron events, paths, or raw error messages reach the renderer. */
export function registerSessionIpc(options: {
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>
  contents: WebContents
  pageUrl: string
  controller: SessionController
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
  register(IPC.getSnapshot, none, () => c.snapshot())
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
  register(IPC.openTool, (a) => a.length === 1 && isAgentTool(a[0]), c.openTool)
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
  return () => {
    for (const channel of channels) ipc.removeHandler(channel)
  }
}
