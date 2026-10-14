// Builders for synthetic Claude Code files, in the shapes observed with Claude Code 2.1.284 to
// 2.1.295 (TASK-008). For tests only: every ID, path, name, and text is made up.

/** A fixed, synthetic start time: 2026-01-15 09:00 UTC. */
export const T0 = Date.UTC(2026, 0, 15, 9, 0, 0)
export const SECOND = 1000
export const MINUTE = 60 * SECOND

export const VERSION = '2.1.295'
export const CWD = '/Users/synthetic/projects/demo'
/** `CWD` as Claude Code names its transcript folder: every character but a-z, A-Z, 0-9 becomes `-`. */
export const CWD_FOLDER = '-Users-synthetic-projects-demo'

/** A synthetic session, record, or catalog ID shaped like a Claude Code UUID. */
export function syntheticId(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
}

/** The fields Claude Code writes on every conversation record. */
function envelope(sessionId: string, uuid: string, at: number): Record<string, unknown> {
  return {
    parentUuid: null,
    isSidechain: false,
    uuid,
    timestamp: new Date(at).toISOString(),
    userType: 'external',
    entrypoint: 'claude-desktop',
    cwd: CWD,
    sessionId,
    version: VERSION,
    gitBranch: 'main'
  }
}

export interface PromptOptions {
  sessionId?: string
  uuid?: string
  /** `human` by default. `task-notification` and `peer` are messages the user did not type. */
  origin?: string | null
  /** Content as text parts instead of a plain string. */
  asParts?: boolean
}

/** A prompt the user typed. */
export function promptLine(text: string, at: number, options: PromptOptions = {}): string {
  const record: Record<string, unknown> = {
    ...envelope(options.sessionId ?? syntheticId(1), options.uuid ?? syntheticId(0x900), at),
    type: 'user',
    promptId: syntheticId(0x800),
    message: {
      role: 'user',
      content: options.asParts === true ? [{ type: 'text', text }] : text
    },
    permissionMode: 'default',
    promptSource: 'sdk'
  }
  const origin = options.origin === undefined ? 'human' : options.origin
  if (origin !== null) record.origin = { kind: origin }
  return JSON.stringify(record)
}

/** A user record Claude Code adds itself, such as a caveat before a slash command's output. */
export function metaUserLine(text: string, at: number, flags: Record<string, boolean>): string {
  return JSON.stringify({
    ...envelope(syntheticId(1), syntheticId(0x901), at),
    type: 'user',
    promptId: syntheticId(0x800),
    message: { role: 'user', content: text },
    ...flags
  })
}

/** A tool's result, which travels back to the model as a user record. */
export function toolResultLine(at: number, isError = false): string {
  return JSON.stringify({
    ...envelope(syntheticId(1), syntheticId(0x902), at),
    type: 'user',
    promptId: syntheticId(0x800),
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_synthetic',
          content: isError ? 'User rejected tool use' : 'Synthetic tool output.',
          is_error: isError
        }
      ]
    },
    toolUseResult: isError ? 'User rejected tool use' : { stdout: 'Synthetic tool output.' },
    sourceToolAssistantUUID: syntheticId(0x903)
  })
}

/** `[Request interrupted by user]` (a stop) or `… for tool use]` (a denied permission). */
export function interruptLine(marker: string, at: number): string {
  return JSON.stringify({
    ...envelope(syntheticId(1), syntheticId(0x904), at),
    type: 'user',
    promptId: syntheticId(0x800),
    message: { role: 'user', content: [{ type: 'text', text: marker }] }
  })
}

export type AssistantPart =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; name: string }

/**
 * One assistant record. Claude Code writes each part of a message as its own record, and every
 * record of the message carries the message's `stop_reason`.
 */
export function assistantLine(
  parts: readonly AssistantPart[],
  at: number,
  options: { uuid?: string; stopReason?: string | null; messageId?: string } = {}
): string {
  const content = parts.map((part) => {
    switch (part.type) {
      case 'text':
        return part
      case 'thinking':
        return { type: 'thinking', thinking: part.thinking, signature: 'synthetic' }
      case 'tool_use':
        return { type: 'tool_use', id: 'toolu_synthetic', name: part.name, input: {} }
    }
  })
  return JSON.stringify({
    ...envelope(syntheticId(1), options.uuid ?? syntheticId(0x905), at),
    type: 'assistant',
    requestId: 'req_synthetic',
    message: {
      model: 'claude-synthetic',
      id: options.messageId ?? 'msg_synthetic',
      type: 'message',
      role: 'assistant',
      content,
      stop_reason: options.stopReason === undefined ? 'end_turn' : options.stopReason,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 }
    }
  })
}

/** The assistant record Claude Code writes when an API error ends the turn. */
export function apiErrorLine(error: string, at: number, uuid = syntheticId(0x906)): string {
  return JSON.stringify({
    ...envelope(syntheticId(1), uuid, at),
    type: 'assistant',
    message: {
      model: '<synthetic>',
      id: 'msg_synthetic_error',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'API Error: synthetic.' }],
      stop_reason: 'stop_sequence',
      stop_sequence: '',
      usage: { input_tokens: 0, output_tokens: 0 }
    },
    isApiErrorMessage: true,
    error,
    apiErrorStatus: 429
  })
}

/** The record Claude Code writes after a completed turn's stop hooks. */
export function stopHookSummaryLine(at: number): string {
  return JSON.stringify({
    ...envelope(syntheticId(1), syntheticId(0x907), at),
    type: 'system',
    subtype: 'stop_hook_summary',
    level: 'suggestion',
    hookCount: 0,
    hookInfos: [],
    hookErrors: [],
    preventedContinuation: false,
    stopReason: '',
    hasOutput: false
  })
}

export function customTitleLine(title: string, sessionId = syntheticId(1)): string {
  return JSON.stringify({ type: 'custom-title', customTitle: title, sessionId })
}

/** A bookkeeping record without a time, such as `agent-name`, `mode`, or `atis-latch`. */
export function bookkeepingLine(type: string, sessionId = syntheticId(1)): string {
  return JSON.stringify({ type, sessionId })
}

/** A record type AgentPeek does not use that has a time, such as `attachment` or `pr-link`. */
export function timedLine(type: string, at: number): string {
  return JSON.stringify({
    ...envelope(syntheticId(1), syntheticId(0x908), at),
    type,
    attachment: { type: 'synthetic' }
  })
}

export interface CatalogOptions {
  cliSessionId: string
  title?: string | null
  cwd?: string
  isArchived?: boolean
  lastActivityAt?: number
  createdAt?: number
}

/** A Desktop catalog file. The real files also hold permission and MCP settings. */
export function catalogJson(options: CatalogOptions): string {
  const record: Record<string, unknown> = {
    sessionId: 'local_synthetic',
    cliSessionId: options.cliSessionId,
    cwd: options.cwd ?? CWD,
    createdAt: options.createdAt ?? T0,
    lastActivityAt: options.lastActivityAt ?? T0,
    model: 'claude-synthetic',
    isArchived: options.isArchived ?? false,
    permissionMode: 'default',
    mcpServers: { synthetic: { command: 'synthetic' } },
    completedTurns: 1,
    lastAssistantUuid: syntheticId(0x905)
  }
  if (options.title !== null) record.title = options.title ?? 'Synthetic session'
  return JSON.stringify(record)
}

export interface RegistryOptions {
  pid: number
  sessionId: string
  status?: string | null
  waitingFor?: string
  name?: string
  cwd?: string
  updatedAt?: number
  procStart?: string | null
}

/** A runtime registry file, `~/.claude/sessions/<pid>.json`. */
export function registryJson(options: RegistryOptions): string {
  const record: Record<string, unknown> = {
    pid: options.pid,
    sessionId: options.sessionId,
    cwd: options.cwd ?? CWD,
    startedAt: T0,
    version: VERSION,
    peerProtocol: 1,
    peerFeatures: [],
    kind: 'interactive',
    entrypoint: 'claude-desktop',
    messagingSocketPath: '/tmp/synthetic.sock',
    name: options.name ?? 'Synthetic session',
    nameSince: T0,
    updatedAt: options.updatedAt ?? T0
  }
  if (options.procStart !== null) record.procStart = options.procStart ?? 'Thu Jan 15 09:00:00 2026'
  // A new registry file has no status for its first fraction of a second.
  if (options.status !== null) {
    record.status = options.status ?? 'idle'
    record.statusUpdatedAt = options.updatedAt ?? T0
  }
  if (options.waitingFor !== undefined) record.waitingFor = options.waitingFor
  return JSON.stringify(record)
}
