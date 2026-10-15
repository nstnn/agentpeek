import type { SessionLocalState } from '../../core/session'
import { AGENT_TOOLS, type AgentTool, isAgentTool } from '../../core/tools'

// The format of AgentPeek's own `state.json` (REQ-010), version 1. It holds pins, read cursors,
// error acknowledgements, and each tool's first-start baseline: IDs, cursors, flags, and times
// only, never message text. AgentPeek is the only program that writes this file, so a file that
// does not match this format exactly is reported as unreadable and never repaired or overwritten.
//
// Example:
// {
//   "version": 1,
//   "baselines": { "codex": 1768467600000 },
//   "sessions": [
//     {
//       "tool": "codex",
//       "id": "00000000-0000-4000-8000-0000000000a1",
//       "pinned": true,
//       "seenCursor": "00000000-0000-4000-8000-0000000000b1",
//       "acknowledgedErrorCursor": null,
//       "lastListedAt": 1768467600000
//     }
//   ]
// }

export const STATE_FILE_VERSION = 1

/** One session's saved state. */
export interface StoredSession extends SessionLocalState {
  tool: AgentTool
  id: string
  /** When a source last listed this session. Entries not listed for 90 days are dropped. */
  lastListedAt: number
}

export interface StateFileData {
  /** Each tool's first-start baseline, from `establishBaseline`, once the tool was first read. */
  baselines: Partial<Record<AgentTool, number>>
  sessions: StoredSession[]
}

export type ParsedStateFile =
  | { kind: 'state'; data: StateFileData }
  // A newer AgentPeek wrote it. Its contents are not checked.
  | { kind: 'newer-version' }
  // Not JSON, or not this format.
  | { kind: 'unreadable' }

/**
 * Whether a value can be stored as a session ID or a cursor: 1 to 200 printable ASCII characters
 * with no spaces, which every tool ID and cursor is (they are UUIDs today). A sentence, a line
 * break, or long text never fits, so message text cannot end up in the file by mistake.
 */
export function isStoredId(value: unknown): value is string {
  return typeof value === 'string' && /^[\x21-\x7e]{1,200}$/.test(value)
}

/** Whether a value can be stored as a time: epoch milliseconds, not negative. */
export function isStoredTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

export function parseStateFile(text: string): ParsedStateFile {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { kind: 'unreadable' }
  }
  if (!isObject(value) || !Number.isSafeInteger(value.version)) return { kind: 'unreadable' }
  if ((value.version as number) > STATE_FILE_VERSION) return { kind: 'newer-version' }
  if (value.version !== STATE_FILE_VERSION) return { kind: 'unreadable' }

  const baselines = parseBaselines(value.baselines)
  if (baselines === null || !Array.isArray(value.sessions)) return { kind: 'unreadable' }
  const sessions: StoredSession[] = []
  const seen = new Set<string>()
  for (const entry of value.sessions) {
    const session = parseSession(entry)
    if (session === null) return { kind: 'unreadable' }
    // AgentPeek never writes a session twice, so a second entry means the file is damaged.
    const key = `${session.tool}:${session.id}`
    if (seen.has(key)) return { kind: 'unreadable' }
    seen.add(key)
    sessions.push(session)
  }
  return { kind: 'state', data: { baselines, sessions } }
}

/** The file's text. Only the fields above are written, by name, so nothing else can slip in. */
export function serializeStateFile(data: StateFileData): string {
  const baselines: Partial<Record<AgentTool, number>> = {}
  for (const tool of AGENT_TOOLS) {
    const at = data.baselines[tool]
    if (at !== undefined) baselines[tool] = at
  }
  const sessions = data.sessions.map((session) => ({
    tool: session.tool,
    id: session.id,
    pinned: session.pinned,
    seenCursor: session.seenCursor,
    acknowledgedErrorCursor: session.acknowledgedErrorCursor,
    lastListedAt: session.lastListedAt
  }))
  return `${JSON.stringify({ version: STATE_FILE_VERSION, baselines, sessions }, null, 2)}\n`
}

function parseBaselines(value: unknown): Partial<Record<AgentTool, number>> | null {
  if (!isObject(value)) return null
  const baselines: Partial<Record<AgentTool, number>> = {}
  for (const tool of AGENT_TOOLS) {
    const at = value[tool]
    if (at === undefined) continue
    if (!isStoredTime(at)) return null
    baselines[tool] = at
  }
  return baselines
}

function parseSession(value: unknown): StoredSession | null {
  if (!isObject(value)) return null
  const { tool, id, pinned, seenCursor, acknowledgedErrorCursor, lastListedAt } = value
  if (!isAgentTool(tool) || !isStoredId(id) || typeof pinned !== 'boolean') return null
  if (!isCursor(seenCursor) || !isCursor(acknowledgedErrorCursor)) return null
  if (!isStoredTime(lastListedAt)) return null
  return { tool, id, pinned, seenCursor, acknowledgedErrorCursor, lastListedAt }
}

function isCursor(value: unknown): value is string | null {
  return value === null || isStoredId(value)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
