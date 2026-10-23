import type { BrowserWindowConstructorOptions } from 'electron'

/** Default and minimum window sizes, in points. */
export const DEFAULT_WINDOW_SIZE = { width: 1280, height: 800 } as const
export const MIN_WINDOW_SIZE = { width: 760, height: 480 } as const

/**
 * Options for the main window.
 *
 * `webPreferences` is the renderer's security baseline: the page runs in Chromium's sandbox,
 * cannot reach Node.js, and talks to the main process only through the object the preload
 * script exposes as `window.agentpeek`. Do not relax these settings.
 */
export function mainWindowOptions(
  preloadPath: string,
  zoomPercent = 100
): BrowserWindowConstructorOptions {
  return {
    title: 'AgentPeek',
    width: DEFAULT_WINDOW_SIZE.width,
    height: DEFAULT_WINDOW_SIZE.height,
    minWidth: MIN_WINDOW_SIZE.width,
    minHeight: MIN_WINDOW_SIZE.height,
    // Shown once the page is ready, so the window never flashes empty.
    show: false,
    webPreferences: {
      preload: preloadPath,
      zoomFactor: zoomPercent / 100,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false
    }
  }
}
