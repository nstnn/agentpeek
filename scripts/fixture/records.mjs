// Synthetic records in the observed Codex 0.162 / Claude Code 2.1.295 shapes.
export const CWD = '/Users/synthetic/projects/fixture-demo'
export const PROJECT = CWD.replace(/[^a-zA-Z0-9]/g, '-')
export const id = (n) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
export const IDS = Object.freeze({
  complete: id(1),
  error: id(2),
  aborted: id(3),
  long: id(4),
  hostile: id(5),
  retry: id(6),
  malformed: id(7),
  old: id(8),
  busy: id(101),
  stopped: id(102),
  apiError: id(103),
  dead: id(104)
})
export const PIDS = Object.freeze({
  busy: 2100000001,
  stopped: 2100000002,
  apiError: 2100000003,
  dead: 2100000004
})
export const HOSTILE = [
  '# Synthetic Markdown safety check',
  '<script>globalThis.fixtureInjected = true</script>',
  '<iframe src="https://example.invalid/frame"></iframe>',
  '![Synthetic remote image](https://example.invalid/image.png)',
  '[Unsafe scheme](javascript:alert(1))',
  '[Synthetic web link](https://example.invalid/fixture)',
  '| Synthetic | Table |\n| --- | --- |\n| one | two |',
  '```text\nSynthetic code block\n```'
].join('\n\n')
export const LONG_REPLY = 'Synthetic long reply. '.repeat(9600)
export const iso = (at) => new Date(at).toISOString()
export const codexEvent = (type, at, extra = {}) =>
  JSON.stringify({
    timestamp: iso(at),
    type: 'event_msg',
    payload: { type, ...extra }
  })
export const meta = (sessionId, at) =>
  JSON.stringify({
    timestamp: iso(at),
    type: 'session_meta',
    payload: {
      id: sessionId,
      session_id: sessionId,
      timestamp: iso(at),
      cwd: CWD,
      source: 'vscode',
      thread_source: 'user',
      cli_version: '0.162.0-alpha.17.2'
    }
  })
export const started = (turn, at) => codexEvent('task_started', at, { turn_id: turn })
export const complete = (turn, at, error) =>
  codexEvent('task_complete', at, {
    turn_id: turn,
    last_agent_message: error ? null : 'Synthetic final reply.',
    ...(error
      ? { error: { message: 'Synthetic failure.', codex_error_info: 'server_overloaded' } }
      : {})
  })
// Synthetic usage-limit figures in the codex-cli 0.145 `token_count` shape. `resets_at` is in
// epoch seconds.
export const tokenCount = (at, primary, secondary, reached = null) =>
  codexEvent('token_count', at, {
    info: null,
    rate_limits: {
      limit_id: 'codex',
      primary: {
        used_percent: primary,
        window_minutes: 300,
        resets_at: Math.floor((at + 3 * 3600000) / 1000)
      },
      secondary: {
        used_percent: secondary,
        window_minutes: 10080,
        resets_at: Math.floor((at + 4 * 86400000) / 1000)
      },
      plan_type: 'plus',
      rate_limit_reached_type: reached
    }
  })
export const codexMessage = (text, at, role = 'AgentMessage') =>
  codexEvent('item_completed', at, {
    item: { type: role, id: id(at), phase: 'final_answer', content: [{ type: 'text', text }] }
  })
export const toolCall = (at) =>
  JSON.stringify({
    timestamp: iso(at),
    type: 'response_item',
    payload: { type: 'function_call', name: 'synthetic_tool' }
  })
// Inputs are invented and displayed only; AgentPeek must never execute them.
export const toolDetailCalls = (at) =>
  [
    'await tools.exec_command({ cmd: "git status --short" });\nawait tools.mcp__example__read({});',
    '// tools.NotCalled({})\nconst text = "tools.NotCalled({}) <script>globalThis.fixtureInjected = true</script>";',
    'const selectedTool = tools[toolName];\nawait selectedTool(args);',
    'await tools.Truncated({});\n//' + 'Synthetic long input. '.repeat(320),
    undefined
  ].map((input, i) =>
    JSON.stringify({
      timestamp: iso(at + i / 10),
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        name: 'exec',
        call_id: `synthetic-call-${i}`,
        ...(input === undefined ? {} : { input })
      }
    })
  )
export const index = (sessionId, title, at) =>
  JSON.stringify({ id: sessionId, thread_name: title, updated_at: iso(at) })
export const claude = (sessionId, type, at, extra = {}) =>
  JSON.stringify({
    sessionId,
    type,
    timestamp: iso(at),
    uuid: id(at),
    version: '2.1.295',
    cwd: CWD,
    isSidechain: false,
    ...extra
  })
export const prompt = (sessionId, at, text = 'Synthetic user prompt.') =>
  claude(sessionId, 'user', at, {
    origin: { kind: 'human' },
    message: { role: 'user', content: text }
  })
export const assistant = (sessionId, at, error = false) =>
  claude(sessionId, 'assistant', at, {
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Synthetic Claude reply.' }],
      stop_reason: error ? 'stop_sequence' : 'end_turn'
    },
    ...(error ? { isApiErrorMessage: true, error: 'rate_limit' } : {})
  })
// Claude calls with each status the detail shows. Inputs are invented and displayed only.
const claudeCall = (sessionId, at, callId, name, input) =>
  claude(sessionId, 'assistant', at, {
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: callId, name, input }],
      stop_reason: 'tool_use'
    }
  })
const claudeResult = (sessionId, at, callId, content, isError = false) =>
  claude(sessionId, 'user', at, {
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: callId, content, is_error: isError }]
    }
  })
export const claudeToolDetailCalls = (sessionId, at) =>
  [
    ['Bash', { command: 'git status --short', description: 'Show the synthetic working tree' }],
    [
      'Edit',
      {
        file_path: `${CWD}/src/app.ts`,
        old_string: 'const synthetic = 1',
        new_string: 'const synthetic = 2\nconst added = true'
      }
    ],
    ['Read', { file_path: `${CWD}/README.md`, offset: 1, limit: 40 }],
    ['Bash', { command: 'npm test', description: 'Run the synthetic tests' }, 'failed'],
    ['mcp__00000000-0000-4000-8000-0000000000aa__web_search', { query: 'synthetic query' }],
    [
      'Write',
      {
        file_path: `${CWD}/notes/long.md`,
        content:
          '<script>globalThis.fixtureInjected = true</script>\n' +
          'Synthetic long line.\n'.repeat(400)
      }
    ],
    ['Bash', { command: 'sleep 30', description: 'Wait for the synthetic build' }, 'pending']
  ].flatMap(([name, input, outcome], i) => {
    const callId = `toolu_synthetic_${i}`
    const use = claudeCall(sessionId, at + i * 10, callId, name, input)
    if (outcome === 'pending') return [use]
    return [
      use,
      outcome === 'failed'
        ? claudeResult(sessionId, at + i * 10 + 1, callId, 'Exit code 1\nSynthetic failure.', true)
        : claudeResult(sessionId, at + i * 10 + 1, callId, 'Synthetic tool output.')
    ]
  })
export const registry = (name, status, at) =>
  JSON.stringify({
    pid: PIDS[name],
    sessionId: IDS[name],
    cwd: CWD,
    name: `Fixture Claude ${name}`,
    version: '2.1.295',
    startedAt: at - 1000,
    updatedAt: at,
    status,
    ...(status === 'waiting' ? { waitingFor: 'permission' } : {})
  })
