import { contextBridge, ipcRenderer } from 'electron'
import { createPreloadApi } from './api'

// The preload script runs before the page loads, in an isolated world with access to a few
// Electron APIs. It exposes exactly one object to the page, `window.agentpeek`, and nothing else.
contextBridge.exposeInMainWorld('agentpeek', createPreloadApi(ipcRenderer))
