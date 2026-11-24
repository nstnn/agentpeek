// Builders for synthetic Antigravity Desktop transcript lines, in the shape observed in 2.34.0
// (TASK-001). For tests only: every ID and text is made up.

/** A fixed, synthetic start time: 2026-01-15 09:00 UTC. */
export const T0 = Date.UTC(2026, 0, 15, 9, 0, 0)
export const SECOND = 1000
export const MINUTE = 60 * SECOND

/** A synthetic conversation ID: a lowercase canonical UUID. */
export function conversationId(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
}

export interface StepOptions {
  step: number
  at?: number
  /** `created_at` exactly as written; an ISO string of `at` by default. */
  createdAt?: unknown
  status?: string
  truncated?: string[]
}

function stepLine(fields: Record<string, unknown>, options: StepOptions): string {
  return JSON.stringify({
    step_index: options.step,
    created_at:
      options.createdAt ?? new Date(options.at ?? T0 + options.step * SECOND).toISOString(),
    status: options.status ?? 'DONE',
    ...fields,
    ...(options.truncated ? { truncated_fields: options.truncated } : {})
  })
}

/** A user prompt, wrapped the way Antigravity wraps it. */
export function userInputLine(options: StepOptions & { text: string }): string {
  const content =
    `<USER_REQUEST>\n${options.text}\n</USER_REQUEST>\n` +
    '<ADDITIONAL_METADATA>\nSynthetic local time and open files.\n</ADDITIONAL_METADATA>'
  return stepLine({ source: 'USER_EXPLICIT', type: 'USER_INPUT', content }, options)
}

/** The first step of a subagent transcript. */
export function systemMessageLine(options: StepOptions & { text?: string }): string {
  return stepLine(
    { source: 'SYSTEM', type: 'SYSTEM_MESSAGE', content: options.text ?? 'Synthetic task.' },
    options
  )
}

/** A step that asks for tools, optionally with commentary. */
export function toolRequestLine(
  options: StepOptions & { tools: string[]; commentary?: string }
): string {
  return stepLine(
    {
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      model: 'synthetic-model',
      input_tokens: 10,
      output_tokens: 5,
      thinking: 'Synthetic thinking that must never be shown.',
      ...(options.commentary !== undefined ? { content: options.commentary } : {}),
      tool_calls: options.tools.map((name) => ({
        name,
        args: { path: '/Users/synthetic/secret-argument.txt' }
      }))
    },
    options
  )
}

/** A turn's final reply: content and no tool calls. */
export function finalReplyLine(options: StepOptions & { text: string }): string {
  return stepLine(
    {
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      model: 'synthetic-model',
      thinking: 'Synthetic thinking that must never be shown.',
      content: options.text
    },
    options
  )
}

/** A tool result. `ERROR` fails the step only. */
export function toolResultLine(options: StepOptions): string {
  return stepLine(
    {
      source: 'MODEL',
      type: 'GENERIC',
      content: 'Synthetic tool output that must never be shown.'
    },
    options
  )
}

/** A step of a type AgentPeek does not know. */
export function unknownStepLine(options: StepOptions): string {
  return stepLine({ source: 'MODEL', type: 'SYNTHETIC_FUTURE_STEP' }, options)
}

/** An annotation file holding a title, in protobuf text format. */
export function annotationText(title: string): string {
  return `title: ${JSON.stringify(title)}\n`
}
