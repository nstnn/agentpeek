import type { SessionKey } from '../core/session'
import type { AppSnapshot, MenuCommand, SelectionPresentation } from '../shared/api'
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
  isFocused?: () => boolean
}) {
  const { service, system } = options
  let selection: SessionKey | null = null
  let detailOpen = false
  let secondPaneOpen = false
  const find = (key: SessionKey | null) =>
    key === null
      ? null
      : (service
          .snapshot()
          .sessions.find((session) => session.key.tool === key.tool && session.key.id === key.id) ??
        null)

  function actions(target: () => SessionKey | null): SessionMenuActions {
    return {
      open: () => {
        const session = find(target())
        if (session) void system.openTool(session.key.tool)
      },
      markRead: () => {
        const session = find(target())
        if (session?.attention.newReply || session?.attention.error) service.markRead(session.key)
      },
      pin: () => {
        const session = find(target())
        if (session) service.setPinned(session.key, !session.pinned)
      },
      copy: () => {
        const session = find(target())
        if (session) void system.copyText(session.key.id).catch(() => undefined)
      },
      openSecondary: () => {
        const session = find(target())
        if (session) options.command({ type: 'open-secondary', key: session.key })
      },
      closeSecondary: () => {
        if (secondPaneOpen) options.command({ type: 'close-secondary' })
      },
      back: () => {
        if (detailOpen) options.command('back')
      }
    }
  }

  return {
    snapshot(): AppSnapshot {
      return { ...service.snapshot(), fixtureHome: options.fixtureHome }
    },
    selected: () => find(selection),
    actions: () => actions(() => selection),
    setSelection: (key: SessionKey | null, presentation?: SelectionPresentation) => {
      selection = find(key)?.key ?? null
      if (presentation) secondPaneOpen = presentation.secondPaneOpen
      options.updateMenu()
    },
    setDetailOpen: (open: boolean) => {
      detailOpen = open
      options.updateMenu()
    },
    canGoBack: () => detailOpen,
    canCloseSecondary: () => secondPaneOpen,
    publish() {
      selection = find(selection)?.key ?? null
      options.updateMenu()
    },
    getMessages: (key: SessionKey, limit: number) =>
      find(key) === null
        ? Promise.resolve({ kind: 'not-found' } as const)
        : service.recentMessages(key, limit),
    setPinned: (key: SessionKey, pinned: boolean) => service.setPinned(key, pinned),
    markRead: (key: SessionKey, expectedCursor?: string) => {
      const session = find(key)
      if (
        !session ||
        (expectedCursor !== undefined &&
          (options.isFocused?.() !== true ||
            selection?.tool !== key.tool ||
            selection?.id !== key.id ||
            session.lastReply?.cursor !== expectedCursor))
      )
        return false
      return service.markRead(key)
    },
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
        return options.popup(
          buildSessionMenu(
            session,
            actions(() => key),
            { context: true }
          )
        )
    }
  }
}

export type SessionController = ReturnType<typeof createSessionController>
