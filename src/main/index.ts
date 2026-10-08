import { app, Menu, session, type BrowserWindow } from 'electron'
import { buildMenuTemplate } from './menu'
import { denyAllPermissions, installNavigationGuards } from './security'
import { createMainWindow } from './window'

// Run every page in Chromium's sandbox, whatever its own options say.
app.enableSandbox()

let mainWindow: BrowserWindow | null = null

// Only one AgentPeek runs at a time. A second launch hands over to the first one and exits.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    app.focus({ steal: true })
    mainWindow.focus()
  })

  installNavigationGuards({ allowReload: !app.isPackaged })

  // Closing the window quits AgentPeek. It never keeps running in the background.
  app.on('window-all-closed', () => app.quit())

  void app.whenReady().then(() => {
    denyAllPermissions(session.defaultSession)
    Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate({ isDev: !app.isPackaged })))
    mainWindow = createMainWindow()
    mainWindow.on('closed', () => {
      mainWindow = null
    })
  })
}
