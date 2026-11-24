import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  app,
  ipcMain,
  Menu,
  nativeTheme,
  powerMonitor,
  session,
  type BrowserWindow
} from 'electron'
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
import { openPreferences, type Preferences } from './preferences'
import {
  shouldStartPreview,
  startPreviewServer,
  type PreviewServer
} from './remote/preview/preview-server'
import { createRemoteView, type RemoteView } from './remote/remote-view'
import type { ZoomAction } from '../shared/preferences'

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
let preferences: Preferences | null = null
let preview: Promise<PreviewServer | null> | null = null
let remote: RemoteView | null = null

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
        canGoBack: controller.canGoBack(),
        canCloseSecondary: controller.canCloseSecondary(),
        zoomPercent: preferences?.getZoom() ?? 100,
        zoom: (action: ZoomAction) => {
          void preferences
            ?.changeZoom(action)
            .then(() => send(IPC.command, { type: 'zoom', percent: preferences?.getZoom() ?? 100 }))
            .catch(() => {
              send(IPC.command, {
                type: 'zoom',
                percent: preferences?.getZoom() ?? 100,
                failed: true
              })
            })
        }
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
    powerMonitor.removeListener('suspend', onSuspend)
    // A quit during the store open stops that service before it can start.
    void (async () => {
      try {
        await Promise.allSettled([
          lifecycle ? lifecycle.stop() : opening?.then((service) => service.stop()),
          preferences?.flush(),
          preview?.then((server) => server?.close()),
          remote?.close()
        ])
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
      app.setAboutPanelOptions({
        applicationName: 'AgentPeek',
        applicationVersion: app.getVersion()
      })
      denyAllPermissions(session.defaultSession)
      preferences = await openPreferences(
        paths.stateFolder,
        (theme) => {
          nativeTheme.themeSource = theme
        },
        (percent) => {
          if (!mainWindow || quitting || mainWindow.webContents.isDestroyed()) return
          mainWindow.webContents.setZoomFactor(percent / 100)
          updateMenu()
        }
      )
      if (quitting) return
      opening = openSessionsService({
        ...paths,
        enabledSources: preferences.getSources(),
        sessionRange: preferences.getSessionRange(),
        onSnapshot: (snapshot) => {
          void preview?.then((server) => server?.publish(snapshot))
          remote?.publish(snapshot)
          controller?.publish()
          if (controller) send(IPC.snapshot, controller.snapshot())
        },
        // Fixture states depend only on fixture files, never on the user's running tools.
        ...(paths.fixture
          ? {
              isCodexAppRunning: () => Promise.resolve(true),
              isAntigravityAppRunning: () => Promise.resolve(true),
              probe: { isAlive: () => Promise.resolve(true) }
            }
          : {})
      })
      const service = await opening
      if (quitting) return
      lifecycle = createServiceLifecycle(service)
      // Off by default: without saved "on" settings this opens no socket.
      remote = createRemoteView({
        folder: paths.stateFolder,
        viewerFolder: join(__dirname, '../remote-web'),
        snapshot: () => service.snapshot(),
        // Recent messages come only from the service's bounded reader, never the controller, so
        // remote reading cannot select, mark read or pin anything.
        recentMessages: (key, limit) => service.recentMessages(key, limit),
        // The sidebar label and Settings follow every change, viewer page counts included.
        onChange: (status) => send(IPC.remoteStatus, status)
      })
      void remote.open().catch(() => undefined)
      if (shouldStartPreview(process.env, paths)) {
        preview = startPreviewServer({ snapshot: () => service.snapshot() }).then(
          (server) => {
            // The development terminal only; the URL carries no session data.
            process.stdout.write(`AgentPeek localhost preview: ${server.url}/\n`)
            return server
          },
          () => {
            process.stdout.write('AgentPeek localhost preview could not start.\n')
            return null
          }
        )
      }
      mainWindow = createMainWindow(preferences.getZoom())
      controller = createSessionController({
        service,
        system: systemActions,
        fixtureHome: paths.fixture ? paths.home : null,
        reload: () => lifecycle!.reload(),
        command: (command: MenuCommand) => send(IPC.command, command),
        updateMenu,
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
        controller,
        preferences,
        setSourceEnabled: service.setSourceEnabled,
        setSessionRange: service.setSessionRange,
        loadOlderSessions: service.loadOlder,
        remote,
        copyText: (text) => systemActions.copyText(text)
      })
      mainWindow.on('focus', () => lifecycle?.focus())
      mainWindow.on('resize', updateMenu)
      mainWindow.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
        if (isMainFrame) {
          controller?.setSelection(null, { secondPaneOpen: false })
          controller?.setDetailOpen(false)
        }
      })
      mainWindow.on('closed', () => {
        mainWindow = null
      })
      powerMonitor.on('resume', onResume)
      powerMonitor.on('suspend', onSuspend)
      updateMenu()
      await service.start()
    })
    .catch(() => {
      // Never print source errors: they may carry paths or conversation text.
      app.quit()
    })
}

function onSuspend(): void {
  remote?.suspend()
}

function onResume(): void {
  remote?.resume()
  void lifecycle?.reload()
}
