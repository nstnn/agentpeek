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
