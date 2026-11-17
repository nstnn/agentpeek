/* Test entry point: observe requests before the built main process creates its window. */
/* eslint-disable @typescript-eslint/no-require-imports */
/* global require, __dirname */
const { app, BrowserWindow, session } = require('electron')
const { isAbsolute, resolve, sep } = require('node:path')
const { fileURLToPath } = require('node:url')
const process = require('node:process')

if (
  !isAbsolute(process.env.AGENTPEEK_HOME || '') ||
  !isAbsolute(process.env.AGENTPEEK_USER_DATA || '')
) {
  throw new Error('The smoke requires both isolated fixture overrides.')
}
// Background mode lets the developer keep using the Mac during a run: the window is
// invisible, click-through and never activated, and native window focus is emulated.
// Playwright drives the page through CDP, which needs neither. Focus-gated behavior is
// then only as real as this emulation, so acceptance evidence still needs a normal run.
if (process.env.AGENTPEEK_E2E_BACKGROUND === '1') {
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
  app.focus = () => undefined
  BrowserWindow.prototype.show = BrowserWindow.prototype.showInactive
  BrowserWindow.prototype.isFocused = function () {
    return !this.isDestroyed()
  }
  BrowserWindow.prototype.focus = function () {
    this.emit('focus')
  }
  app.on('browser-window-created', (_event, window) => {
    window.setOpacity(0)
    window.setIgnoreMouseEvents(true)
  })
  // Chromium starts no drag in a click-through window; a spec lifts it for one drag.
  globalThis.agentpeekPointerInput = (enabled) => {
    for (const window of BrowserWindow.getAllWindows()) window.setIgnoreMouseEvents(!enabled)
  }
  app.whenReady().then(() => app.dock?.hide())
}
globalThis.agentpeekSmokeAudit = []
const rendererRoot = resolve(__dirname, '../out/renderer') + sep
app.once('ready', () => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    let ownFile = false
    try {
      ownFile =
        details.url.startsWith('file:') && fileURLToPath(details.url).startsWith(rendererRoot)
    } catch {
      /* An invalid URL is a failed audit entry. */
    }
    globalThis.agentpeekSmokeAudit.push({ url: details.url, ownFile })
    callback({}) // Observe; never intercept a forbidden request to manufacture a pass.
  })
})
require('../out/main/index.js')
