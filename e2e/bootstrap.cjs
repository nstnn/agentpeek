/* Test entry point: observe requests before the built main process creates its window. */
/* eslint-disable @typescript-eslint/no-require-imports */
/* global require, __dirname */
const { app, session } = require('electron')
const { isAbsolute, resolve, sep } = require('node:path')
const { fileURLToPath } = require('node:url')
const process = require('node:process')

if (
  !isAbsolute(process.env.AGENTPEEK_HOME || '') ||
  !isAbsolute(process.env.AGENTPEEK_USER_DATA || '')
) {
  throw new Error('The smoke requires both isolated fixture overrides.')
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
