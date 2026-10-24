import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, screen } from 'electron'
import { DEFAULT_WINDOW_SIZE, mainWindowOptions } from './window-options'
import { fitWindowBounds, readWindowState, saveWindowState } from './window-state'

/** Creates the AgentPeek window and loads the interface into it. */
export function rendererPageUrl(): string {
  return !app.isPackaged && process.env['ELECTRON_RENDERER_URL']
    ? new URL(process.env['ELECTRON_RENDERER_URL']).href
    : pathToFileURL(join(__dirname, '../renderer/index.html')).href
}

export function createMainWindow(zoomPercent = 100): BrowserWindow {
  const folder = app.getPath('userData')
  const saved = readWindowState(folder)
  const workArea = saved
    ? screen.getDisplayMatching(saved.bounds).workArea
    : screen.getPrimaryDisplay().workArea
  const bounds = fitWindowBounds(
    saved?.bounds ?? {
      ...DEFAULT_WINDOW_SIZE,
      x: Math.round(workArea.x + (workArea.width - DEFAULT_WINDOW_SIZE.width) / 2),
      y: Math.round(workArea.y + (workArea.height - DEFAULT_WINDOW_SIZE.height) / 2)
    },
    workArea
  )
  const window = new BrowserWindow({
    ...mainWindowOptions(join(__dirname, '../preload/index.js'), zoomPercent),
    ...bounds
  })

  window.once('ready-to-show', () => {
    if (saved?.maximized ?? true) window.maximize()
    window.show()
    if (saved?.fullScreen) window.setFullScreen(true)
  })
  window.on('close', () => {
    saveWindowState(folder, {
      bounds: window.getNormalBounds(),
      maximized: window.isMaximized(),
      fullScreen: window.isFullScreen()
    })
  })

  // `npm run dev` serves the interface from electron-vite's dev server, with hot reload.
  // A build loads the bundled files from disk.
  void window.loadURL(rendererPageUrl())

  return window
}
