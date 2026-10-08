import type { AgentPeekApi } from '../../shared/api'

declare global {
  interface Window {
    /** Exposed by the preload script. The renderer's only way to reach the main process. */
    readonly agentpeek: AgentPeekApi
  }
}
