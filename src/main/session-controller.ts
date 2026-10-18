import type { SessionKey } from '../core/session'
import type { AppSnapshot, MenuCommand } from '../shared/api'
import type { SessionsService } from './sessions/service'
import { buildSessionMenu, type SessionMenuActions } from './menu'
import type { MenuItemConstructorOptions } from 'electron'
import type { SystemActions } from './system-actions'

/** Owns selection and actions; menu callbacks look up the latest published session. */
export function createSessionController(options: {
  service: SessionsService
  system: SystemActions
  fixtureHome: string | null
  reload: () => Promise<void>
  command: (command: MenuCommand) => void
  updateMenu: () => void
  popup: (template: MenuItemConstructorOptions[]) => void | Promise<void>
}) {
  const { service, system } = options
  let selection: SessionKey | null = null
  const find = (key: SessionKey | null) =>
    key === null
      ? null
      : (service
          .snapshot()
          .sessions.find((session) => session.key.tool === key.tool && session.key.id === key.id) ??
        null)

  function actions(key: SessionKey | null): SessionMenuActions {
    return {
      open: () => {
        const session = find(key)
        if (session) void system.openTool(session.key.tool)
      },
      markRead: () => {
        const session = find(key)
        if (session?.attention.newReply || session?.attention.error) service.markRead(session.key)
      },
      pin: () => {
        const session = find(key)
        if (session) service.setPinned(session.key, !session.pinned)
      },
      copy: () => {
        const session = find(key)
        if (session) void system.copyText(session.key.id).catch(() => undefined)
      },
      back: () => options.command('back')
    }
  }

  return {
    snapshot(): AppSnapshot {
      return { ...service.snapshot(), fixtureHome: options.fixtureHome }
    },
    selected: () => find(selection),
    actions: () => actions(selection),
    setSelection: (key: SessionKey | null) => {
      selection = find(key)?.key ?? null
      options.updateMenu()
    },
    publish() {
      selection = find(selection)?.key ?? null
      options.updateMenu()
    },
    getMessages: (key: SessionKey, limit: number) =>
      find(key) === null
        ? Promise.resolve({ kind: 'not-found' } as const)
        : service.recentMessages(key, limit),
    setPinned: (key: SessionKey, pinned: boolean) => service.setPinned(key, pinned),
    markRead: (key: SessionKey) => service.markRead(key),
    openTool: (tool: SessionKey['tool']) => system.openTool(tool),
    copySessionId: async (key: SessionKey) => {
      const session = find(key)
      if (!session) return false
      await system.copyText(session.key.id)
      return true
    },
    openLink: (url: string) => system.openLink(url),
    reload: options.reload,
    showSessionMenu: (key: SessionKey) => {
      const session = find(key)
      if (session)
        return options.popup(buildSessionMenu(session, actions(session.key), { context: true }))
    }
  }
}

export type SessionController = ReturnType<typeof createSessionController>
