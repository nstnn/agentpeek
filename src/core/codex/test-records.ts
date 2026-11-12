// Builders for synthetic Codex lines, in the shape observed in rollouts with `cli_version`
// 0.162.0-alpha.17.2 (TASK-007). For tests only: every ID, path, and text is made up.

/** A fixed, synthetic start time: 2026-01-15 09:00 UTC. */
export const T0 = Date.UTC(2026, 0, 15, 9, 0, 0)
export const SECOND = 1000
export const MINUTE = 60 * SECOND

/** A synthetic thread or turn ID shaped like a Codex UUID. */
export function syntheticId(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
}

/** One rollout line: the envelope Codex writes around every payload. */
export function rolloutLine(type: string, payload: object, at: number): string {
  return JSON.stringify({ timestamp: new Date(at).toISOString(), type, payload })
}

export interface MetaOptions {
  id: string
  at?: number
  /** `vscode` for user threads; an object for child threads. */
  source?: unknown
  threadSource?: string
  parentThreadId?: string
  cwd?: string
  cliVersion?: string
}

/** A `session_meta` first line. The defaults describe a user thread. */
export function sessionMetaLine(options: MetaOptions): string {
  const payload: Record<string, unknown> = {
    session_id: options.id,
    id: options.id,
    timestamp: new Date(options.at ?? T0).toISOString(),
    cwd: options.cwd ?? '/Users/synthetic/projects/demo',
    originator: 'Codex Desktop',
    cli_version: options.cliVersion ?? '0.162.0-alpha.17.2',
    source: options.source ?? 'vscode',
    thread_source: options.threadSource ?? 'user',
    model_provider: 'openai',
    base_instructions: { text: 'Synthetic base instructions.' }
  }
  if (options.parentThreadId !== undefined) payload.parent_thread_id = options.parentThreadId
  return rolloutLine('session_meta', payload, options.at ?? T0)
}

/** A `guardian_review` child thread's first line, as Codex writes for an approval review. */
export function childMetaLine(id: string, parentId: string, at = T0): string {
  return sessionMetaLine({
    id,
    at,
    source: { subagent: { other: 'guardian' } },
    threadSource: 'guardian_review',
    parentThreadId: parentId
  })
}

export function taskStartedLine(turnId: string, at: number): string {
  return rolloutLine(
    'event_msg',
    {
      type: 'task_started',
      turn_id: turnId,
      root_turn_id: turnId,
      started_at: Math.floor(at / 1000),
      model_context_window: 258400,
      collaboration_mode_kind: 'default'
    },
    at
  )
}

export function taskCompleteLine(
  turnId: string,
  at: number,
  options: { message?: string | null; error?: object | null } = {}
): string {
  const payload: Record<string, unknown> = {
    type: 'task_complete',
    turn_id: turnId,
    last_agent_message: options.message === undefined ? 'Synthetic final answer.' : options.message,
    started_at: Math.floor(at / 1000) - 5,
    completed_at: Math.floor(at / 1000),
    duration_ms: 5000,
    root_turn_id: turnId
  }
  // Codex leaves the key out when there is no error.
  if (options.error !== undefined) payload.error = options.error
  return rolloutLine('event_msg', payload, at)
}

export function turnAbortedLine(turnId: string, at: number): string {
  return rolloutLine(
    'event_msg',
    {
      type: 'turn_aborted',
      turn_id: turnId,
      reason: 'interrupted',
      started_at: Math.floor(at / 1000) - 5,
      completed_at: Math.floor(at / 1000),
      duration_ms: 5000,
      root_turn_id: turnId
    },
    at
  )
}

/** The prompt as the Codex app shows it. */
export function userMessageLine(text: string, at: number): string {
  return rolloutLine(
    'event_msg',
    {
      type: 'item_completed',
      thread_id: syntheticId(1),
      turn_id: syntheticId(100),
      item: {
        type: 'UserMessage',
        id: 'item-user',
        client_id: 'client-1',
        content: [{ type: 'text', text, text_elements: [] }]
      },
      started_at_ms: at,
      completed_at_ms: at
    },
    at
  )
}

/** A reply as the Codex app shows it: a progress note (`commentary`) or the final answer. */
export function agentMessageLine(
  text: string,
  at: number,
  phase: 'commentary' | 'final_answer' = 'final_answer'
): string {
  return rolloutLine(
    'event_msg',
    {
      type: 'item_completed',
      thread_id: syntheticId(1),
      turn_id: syntheticId(100),
      item: { type: 'AgentMessage', id: 'item-agent', content: [{ type: 'Text', text }], phase },
      started_at_ms: at,
      completed_at_ms: at
    },
    at
  )
}

/** The `response_item` copy of a message, which also carries context Codex adds itself. */
export function responseMessageLine(role: string, text: string, at: number): string {
  const type = role === 'assistant' ? 'output_text' : 'input_text'
  return rolloutLine(
    'response_item',
    { type: 'message', id: 'msg-1', role, content: [{ type, text }] },
    at
  )
}

export function toolCallLine(name: string | null, at: number, type = 'function_call'): string {
  const payload: Record<string, unknown> = { type, id: 'call-item', call_id: 'call-1' }
  if (name !== null) payload.name = name
  if (type === 'function_call') payload.arguments = '{"synthetic":true}'
  if (type === 'custom_tool_call') payload.input = 'synthetic input'
  return rolloutLine('response_item', payload, at)
}

export function toolOutputLine(at: number, type = 'function_call_output'): string {
  return rolloutLine(
    'response_item',
    { type, id: 'output-item', call_id: 'call-1', output: 'Synthetic tool output.' },
    at
  )
}

/** A record type AgentPeek does not use, such as `world_state` or `token_usage_record`. */
export function unknownLine(type: string, at: number): string {
  return rolloutLine(type, { synthetic: true }, at)
}

/** One `session_index.jsonl` line. */
export function indexLine(id: string, name: string, at: number): string {
  return JSON.stringify({ id, thread_name: name, updated_at: new Date(at).toISOString() })
}

/** A `token_count` event with synthetic usage figures, in the codex-cli 0.145 shape. */
export function tokenCountLine(
  at: number,
  rateLimits: object | null = {
    primary: { used_percent: 16, window_minutes: 300, resets_at: (at + 3 * 60 * MINUTE) / 1000 },
    secondary: {
      used_percent: 43,
      window_minutes: 10080,
      resets_at: (at + 4 * 24 * 60 * MINUTE) / 1000
    },
    plan_type: 'plus',
    rate_limit_reached_type: null
  }
): string {
  return rolloutLine('event_msg', { type: 'token_count', info: null, rate_limits: rateLimits }, at)
}
