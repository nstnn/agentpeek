import type { MenuItemConstructorOptions } from 'electron'

/**
 * The application menu bar. On macOS the first menu always shows the app's name.
 *
 * Reload Sessions stays disabled until AgentPeek reads sessions. Developer tools
 * appear only in development builds.
 */
export function buildMenuTemplate({ isDev }: { isDev: boolean }): MenuItemConstructorOptions[] {
  const viewItems: MenuItemConstructorOptions[] = [
    {
      id: 'reload-sessions',
      label: 'Reload Sessions',
      accelerator: 'CommandOrControl+R',
      enabled: false
    }
  ]
  if (isDev) {
    viewItems.push({ type: 'separator' }, { role: 'toggleDevTools' })
  }

  return [
    { label: 'AgentPeek', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }] },
    { label: 'Edit', submenu: [{ role: 'copy' }, { role: 'selectAll' }] },
    { label: 'View', submenu: viewItems },
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
