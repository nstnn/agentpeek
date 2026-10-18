import type { MenuItemConstructorOptions } from 'electron'
import type { Session } from '../core/session'
import type { MenuCommand } from '../shared/api'

export interface SessionMenuActions {
  open(this: void): void
  markRead(this: void): void
  pin(this: void): void
  copy(this: void): void
  back(this: void): void
}

export function buildSessionMenu(
  session: Session | null,
  actions: SessionMenuActions,
  options: { context?: boolean; canGoBack?: boolean } = {}
): MenuItemConstructorOptions[] {
  const enabled = session !== null
  const items: MenuItemConstructorOptions[] = [
    {
      id: 'session-open',
      label: session?.key.tool === 'claude' ? 'Open Claude' : 'Open Codex',
      accelerator: 'CommandOrControl+O',
      enabled,
      click: actions.open
    },
    {
      id: 'session-mark-read',
      label: 'Mark Read',
      accelerator: 'Shift+CommandOrControl+U',
      enabled: enabled && (session.attention.newReply || session.attention.error),
      click: actions.markRead
    },
    {
      id: 'session-pin',
      label: session?.pinned ? 'Unpin' : 'Pin',
      accelerator: 'Shift+CommandOrControl+P',
      enabled,
      click: actions.pin
    },
    {
      id: 'session-copy',
      label: 'Copy Session ID',
      accelerator: 'Alt+CommandOrControl+C',
      enabled,
      click: actions.copy
    }
  ]
  if (!options.context)
    items.push(
      { type: 'separator' },
      {
        id: 'session-back',
        label: 'Back',
        accelerator: 'CommandOrControl+[',
        enabled: enabled && options.canGoBack === true,
        click: actions.back
      }
    )
  return items
}

/** The native application menu; session actions are always resolved in the main process. */
export function buildMenuTemplate(options: {
  isDev: boolean
  reload: () => void
  command: (command: MenuCommand) => void
  session: Session | null
  actions: SessionMenuActions
  canGoBack: boolean
}): MenuItemConstructorOptions[] {
  const viewItems: MenuItemConstructorOptions[] = [
    {
      label: 'Active',
      accelerator: 'CommandOrControl+1',
      click: () => options.command('view:active')
    },
    {
      label: 'Pinned',
      accelerator: 'CommandOrControl+2',
      click: () => options.command('view:pinned')
    },
    {
      label: 'All Sessions',
      accelerator: 'CommandOrControl+3',
      click: () => options.command('view:all')
    },
    { type: 'separator' },
    {
      id: 'reload-sessions',
      label: 'Reload Sessions',
      accelerator: 'CommandOrControl+R',
      enabled: true,
      click: options.reload
    }
  ]
  if (options.isDev) {
    viewItems.push({ type: 'separator' }, { role: 'toggleDevTools' })
  }

  return [
    { label: 'AgentPeek', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }] },
    { label: 'Edit', submenu: [{ role: 'copy' }, { role: 'selectAll' }] },
    { label: 'View', submenu: viewItems },
    { label: 'Session', submenu: buildSessionMenu(options.session, options.actions, options) },
    {
      label: 'Window',
      role: 'window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { role: 'close' },
        { type: 'separator' },
        { role: 'front' }
      ]
    }
  ]
}
