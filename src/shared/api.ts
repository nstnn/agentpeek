/**
 * The object the preload script exposes to the renderer as `window.agentpeek`.
 *
 * It is empty for now. Every member added later must take and return plain data,
 * never an Electron or Node.js object.
 */
export type AgentPeekApi = Readonly<Record<string, never>>
