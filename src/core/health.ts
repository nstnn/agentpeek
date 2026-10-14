/**
 * How well AgentPeek can read one tool's files, shown in the sidebar's Sources section.
 * `lastReadAt` is the time of the last successful read.
 */
export type ToolHealth =
  | { state: 'checking' }
  | { state: 'connected'; lastReadAt: number }
  | { state: 'not-installed' }
  | { state: 'no-access'; lastReadAt: number | null }
  | { state: 'unsupported'; toolVersion: string | null }
