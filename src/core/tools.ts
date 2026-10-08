/** The coding agents AgentPeek reads from. */
export const AGENT_TOOLS = ['codex', 'claude'] as const

export type AgentTool = (typeof AGENT_TOOLS)[number]

/** Checks a value from outside the type system, such as an IPC argument, before it is trusted. */
export function isAgentTool(value: unknown): value is AgentTool {
  return typeof value === 'string' && (AGENT_TOOLS as readonly string[]).includes(value)
}
