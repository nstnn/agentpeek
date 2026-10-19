import { homedir } from 'node:os'
import { app, ipcMain, Menu, powerMonitor, session, type BrowserWindow } from 'electron'
import type { MenuCommand } from '../shared/api'
import { IPC } from '../shared/ipc'
import { registerSessionIpc } from './ipc'
import { buildMenuTemplate } from './menu'
import { denyAllPermissions, installNavigationGuards } from './security'
import { createSessionController, type SessionController } from './session-controller'
import { resolveSessionPaths } from './session-paths'
import { createServiceLifecycle } from './service-lifecycle'
import { openSessionsService } from './sessions/open-sessions'
import type { SessionsService } from './sessions/service'
import { systemActions } from './system-actions'
import { createMainWindow, rendererPageUrl } from './window'

app.enableSandbox()
// Set userData before acquiring the single-instance lock, so fixture runs are fully isolated.
const paths = resolveSessionPaths(process.env, homedir(), app.getPath('userData'))
if (paths.fixture) app.setPath('userData', paths.stateFolder)

let mainWindow: BrowserWindow | null = null
let opening: Promise<SessionsService> | null = null
let lifecycle: ReturnType<typeof createServiceLifecycle> | null = null
let controller: SessionController | null = null
let removeIpc: (() => void) | null = null
let quitting = false
let quitReady = false

function send(channel: string, value: unknown): void {
  const contents = mainWindow?.webContents
  if (quitting || !contents || contents.isDestroyed() || contents.getURL() !== rendererPageUrl())
    return
  contents.send(channel, value)
}

function updateMenu(): void {
  if (quitting || !controller || !mainWindow) return
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      buildMenuTemplate({
        isDev: !app.isPackaged,
        reload: () => {
          void lifecycle?.reload()
        },
        command: (command) => send(IPC.command, command),
        session: controller.selected(),
        actions: controller.actions(),
        canGoBack: controller.canGoBack()
      })
    )
  )
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow || quitting) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    app.focus({ steal: true })
    mainWindow.focus()
  })
  installNavigationGuards({ allowReload: !app.isPackaged })
  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', (event) => {
    if (quitReady) return
    event.preventDefault()
    if (quitting) return
    quitting = true
    removeIpc?.()
    powerMonitor.removeListener('resume', onResume)
    // A quit during the store open stops that service before it can start.
    void (async () => {
      try {
        if (lifecycle) await lifecycle.stop()
        else await (await opening)?.stop()
      } finally {
        quitReady = true
        app.quit()
      }
    })().catch(() => undefined)
  })

  void app
    .whenReady()
    .then(async () => {
      if (quitting) return
      denyAllPermissions(session.defaultSession)
      opening = openSessionsService({
        ...paths,
        onSnapshot: () => {
          controller?.publish()
          if (controller) send(IPC.snapshot, controller.snapshot())
        },
        // Fixture states depend only on fixture files, never on the user's running tools.
        ...(paths.fixture
          ? {
              isCodexAppRunning: () => Promise.resolve(true),
              probe: { isAlive: () => Promise.resolve(true) }
            }
          : {})
      })
      const service = await opening
      if (quitting) return
      lifecycle = createServiceLifecycle(service)
      mainWindow = createMainWindow()
      controller = createSessionController({
        service,
        system: systemActions,
        fixtureHome: paths.fixture ? paths.home : null,
        reload: () => lifecycle!.reload(),
        command: (command: MenuCommand) => send(IPC.command, command),
        updateMenu,
        isNarrow: () => (mainWindow?.getContentSize()[0] ?? 1000) < 1000,
        isFocused: () => mainWindow?.isFocused() ?? false,
        popup: (template) =>
          new Promise<void>((resolve) => {
            if (mainWindow && !quitting)
              Menu.buildFromTemplate(template).popup({ window: mainWindow, callback: resolve })
            else resolve()
          })
      })
      removeIpc = registerSessionIpc({
        ipc: ipcMain,
        contents: mainWindow.webContents,
        pageUrl: rendererPageUrl(),
        controller
      })
      mainWindow.on('focus', () => lifecycle?.focus())
      mainWindow.on('resize', updateMenu)
      mainWindow.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
        if (isMainFrame) controller?.setSelection(null)
      })
      mainWindow.on('closed', () => {
        mainWindow = null
      })
      powerMonitor.on('resume', onResume)
      updateMenu()
      await service.start()
    })
    .catch(() => {
      // Never print source errors: they may carry paths or conversation text.
      app.quit()
    })
}

function onResume(): void {
  void lifecycle?.reload()
}
