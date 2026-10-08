import { contextBridge } from 'electron'
import type { AgentPeekApi } from '../shared/api'

// The preload script runs before the page loads, in an isolated world with access to a few
// Electron APIs. It exposes exactly one object to the page, `window.agentpeek`, and nothing else.
const api: AgentPeekApi = {}

contextBridge.exposeInMainWorld('agentpeek', api)
