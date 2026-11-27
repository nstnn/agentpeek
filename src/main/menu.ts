import type { MenuItemConstructorOptions } from 'electron'
import type { Session } from '../core/session'
import type { MenuCommand } from '../shared/api'
import type { AgentTool } from '../core/tools'
import { MIN_ZOOM, MAX_ZOOM, type ZoomAction } from '../shared/preferences'

export interface SessionMenuActions {
  open(this: void): void
  markRead(this: void): void
  pin(this: void): void
  copy(this: void): void
  openPrimary(this: void): void
  openSecondary(this: void): void
  closeSecondary(this: void): void
  back(this: void): void
}

const OPEN_LABELS: Readonly<Record<AgentTool, string>> = {
  codex: 'Open Codex',
  claude: 'Open Claude',
  antigravity: 'Open Antigravity'
}

export function buildSessionMenu(
  session: Session | null,
  actions: SessionMenuActions,
  options: { context?: boolean; canGoBack?: boolean; canCloseSecondary?: boolean } = {}
): MenuItemConstructorOptions[] {
  const enabled = session !== null
  const items: MenuItemConstructorOptions[] = [
    ...(options.canCloseSecondary
      ? [
          {
            id: 'session-open-primary',
            label: 'Open in Left Pane',
            enabled,
            click: actions.openPrimary
          }
        ]
      : []),
    {
      id: 'session-open-secondary',
      label: options.canCloseSecondary ? 'Open in Right Pane' : 'Open to the Right',
      enabled,
      click: actions.openSecondary
    },
    { type: 'separator' },
    {
      id: 'session-open',
      label: OPEN_LABELS[session?.key.tool ?? 'codex'],
      accelerator: 'CommandOrControl+O',
      enabled: enabled && !session.unavailable,
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
        id: 'session-close-secondary',
        label: 'Close Right Pane',
        enabled: options.canCloseSecondary === true,
        click: actions.closeSecondary
      },
      {
        id: 'session-back',
        label: 'Back',
        accelerator: 'CommandOrControl+[',
        enabled: options.canGoBack === true,
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
  canCloseSecondary: boolean
  zoomPercent: number
  zoom: (action: ZoomAction) => void
}): MenuItemConstructorOptions[] {
  const viewItems: MenuItemConstructorOptions[] = [
    {
      label: 'Find Session…',
      accelerator: 'CommandOrControl+K',
      click: () => options.command('quick-open')
    },
    { type: 'separator' },
    {
      label: 'Active',
      accelerator: 'CommandOrControl+1',
      click: () => options.command('view:active')
    },
    {
      label: 'Inbox',
      accelerator: 'CommandOrControl+2',
      click: () => options.command('view:inbox')
    },
    {
      label: 'Pinned',
      accelerator: 'CommandOrControl+3',
      click: () => options.command('view:pinned')
    },
    {
      label: 'All Sessions',
      accelerator: 'CommandOrControl+4',
      click: () => options.command('view:all')
    },
    { type: 'separator' },
    {
      id: 'reload-sessions',
      label: 'Reload Sessions',
      accelerator: 'CommandOrControl+R',
      enabled: true,
      click: options.reload
    },
    { type: 'separator' },
    {
      id: 'zoom-in',
      label: 'Zoom In',
      accelerator: 'CommandOrControl+Plus',
      enabled: options.zoomPercent < MAX_ZOOM,
      click: () => options.zoom('in')
    },
    {
      id: 'zoom-in-equals',
      label: 'Zoom In',
      accelerator: 'CommandOrControl+=',
      visible: false,
      acceleratorWorksWhenHidden: true,
      enabled: options.zoomPercent < MAX_ZOOM,
      click: () => options.zoom('in')
    },
    {
      id: 'zoom-out',
      label: 'Zoom Out',
      accelerator: 'CommandOrControl+-',
      enabled: options.zoomPercent > MIN_ZOOM,
      click: () => options.zoom('out')
    },
    {
      id: 'zoom-reset',
      label: 'Actual Size',
      accelerator: 'CommandOrControl+0',
      click: () => options.zoom('reset')
    },
    { label: `Zoom: ${options.zoomPercent}%`, enabled: false }
  ]
  if (options.isDev) {
    viewItems.push({ type: 'separator' }, { role: 'toggleDevTools' })
  }

  return [
    {
      label: 'AgentPeek',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: 'Settings…',
          accelerator: 'CommandOrControl+,',
          click: () => options.command('settings')
        },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
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
