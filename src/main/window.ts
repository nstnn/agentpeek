import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import { mainWindowOptions } from './window-options'

/** Creates the AgentPeek window and loads the interface into it. */
export function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow(mainWindowOptions(join(__dirname, '../preload/index.js')))

  window.once('ready-to-show', () => window.show())

  // `npm run dev` serves the interface from electron-vite's dev server, with hot reload.
  // A build loads the bundled files from disk.
  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devServerUrl) {
    void window.loadURL(devServerUrl)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}
