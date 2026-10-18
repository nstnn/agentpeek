import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow } from 'electron'
import { mainWindowOptions } from './window-options'

/** Creates the AgentPeek window and loads the interface into it. */
export function rendererPageUrl(): string {
  return !app.isPackaged && process.env['ELECTRON_RENDERER_URL']
    ? new URL(process.env['ELECTRON_RENDERER_URL']).href
    : pathToFileURL(join(__dirname, '../renderer/index.html')).href
}

export function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow(mainWindowOptions(join(__dirname, '../preload/index.js')))

  window.once('ready-to-show', () => window.show())

  // `npm run dev` serves the interface from electron-vite's dev server, with hot reload.
  // A build loads the bundled files from disk.
  void window.loadURL(rendererPageUrl())

  return window
}
