/**
 * How well AgentPeek can read one tool's files, shown in Settings and the connected-source footer.
 * `lastReadAt` is the time of the last successful read.
 */
export type ToolHealth =
  | { state: 'off' }
  | { state: 'checking' }
  | { state: 'connected'; lastReadAt: number }
  | { state: 'not-installed' }
  | { state: 'no-access'; lastReadAt: number | null }
  | { state: 'unsupported'; toolVersion: string | null }
