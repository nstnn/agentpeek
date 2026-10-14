import { describe, expect, it } from 'vitest'
import { parseIndexLine, parseRecord, parseSessionMeta } from './records'
import {
  agentMessageLine,
  childMetaLine,
  indexLine,
  responseMessageLine,
  rolloutLine,
  sessionMetaLine,
  syntheticId,
  T0,
  taskCompleteLine,
  taskStartedLine,
  toolCallLine,
  toolOutputLine,
  turnAbortedLine,
  unknownLine,
  userMessageLine
} from './test-records'

// Synthetic lines only, in the shape observed in Codex rollouts (TASK-007).
const THREAD = syntheticId(1)
const TURN = syntheticId(100)

describe('parseSessionMeta', () => {
  it('recognizes a user thread', () => {
    expect(parseSessionMeta(sessionMetaLine({ id: THREAD }))).toEqual({
      kind: 'meta',
      meta: {
        id: THREAD,
        isUserThread: true,
        cwd: '/Users/synthetic/projects/demo',
        cliVersion: '0.162.0-alpha.17.2'
      }
    })
  })

  it('treats a guardian_review child as not a user thread', () => {
    const result = parseSessionMeta(childMetaLine(syntheticId(2), THREAD))
    expect(result).toMatchObject({ kind: 'meta', meta: { isUserThread: false } })
  })

  it.each([
    ['a subagent child', { source: { subagent: 'worker' }, threadSource: 'subagent' }],
    ['an automation thread', { threadSource: 'automation' }],
    ['a thread with a parent', { parentThreadId: syntheticId(9) }],
    ['a thread with an object source', { source: { other: 'x' } }]
  ])('treats %s as not a user thread', (_name, options) => {
    const result = parseSessionMeta(sessionMetaLine({ id: THREAD, ...options }))
    expect(result).toMatchObject({ kind: 'meta', meta: { isUserThread: false } })
  })

  it('treats a missing thread_source as not a user thread', () => {
    const line = JSON.stringify({
      timestamp: new Date(T0).toISOString(),
      type: 'session_meta',
      payload: { id: THREAD, source: 'cli' }
    })
    expect(parseSessionMeta(line)).toMatchObject({ meta: { isUserThread: false, cwd: null } })
  })

  it('ignores unknown keys', () => {
    const line = rolloutLine(
      'session_meta',
      { id: THREAD, source: 'vscode', thread_source: 'user', brand_new_key: { a: 1 } },
      T0
    )
    expect(parseSessionMeta(line)).toMatchObject({ kind: 'meta', meta: { isUserThread: true } })
  })

  it('reports another first line as unrecognized, with the version when it has one', () => {
    expect(parseSessionMeta(taskStartedLine(TURN, T0))).toEqual({
      kind: 'unrecognized',
      cliVersion: null
    })
    const withoutId = rolloutLine('session_meta', { cli_version: '9.0.0', source: 'vscode' }, T0)
    expect(parseSessionMeta(withoutId)).toEqual({ kind: 'unrecognized', cliVersion: '9.0.0' })
  })

  it('reports a malformed line as unrecognized', () => {
    expect(parseSessionMeta('{"type":"session_meta","payl')).toEqual({
      kind: 'unrecognized',
      cliVersion: null
    })
    expect(parseSessionMeta('[1,2,3]')).toEqual({ kind: 'unrecognized', cliVersion: null })
  })
})

describe('parseRecord', () => {
  it('reads task_started', () => {
    expect(parseRecord(taskStartedLine(TURN, T0))).toEqual({ kind: 'turn-started', at: T0 })
  })

  it('reads a task_complete with a final reply', () => {
    expect(parseRecord(taskCompleteLine(TURN, T0))).toEqual({
      kind: 'turn-completed',
      at: T0,
      outcome: { turnId: TURN, isError: false, errorCode: null }
    })
  })

  it('reads a task_complete with an error', () => {
    const line = taskCompleteLine(TURN, T0, {
      message: null,
      error: { codex_error_info: 'server_overloaded', message: 'Synthetic error.' }
    })
    expect(parseRecord(line)).toEqual({
      kind: 'turn-completed',
      at: T0,
      outcome: { turnId: TURN, isError: true, errorCode: 'server_overloaded' }
    })
  })

  it('reads an error kind that carries details, and an error without a kind', () => {
    const detailed = taskCompleteLine(TURN, T0, {
      error: { codex_error_info: { http_connection_failed: { http_status_code: 502 } } }
    })
    expect(parseRecord(detailed)).toMatchObject({
      outcome: { isError: true, errorCode: 'http_connection_failed' }
    })
    const bare = taskCompleteLine(TURN, T0, { error: { message: 'Synthetic error.' } })
    expect(parseRecord(bare)).toMatchObject({ outcome: { isError: true, errorCode: null } })
  })

  it('treats a null error like no error', () => {
    expect(parseRecord(taskCompleteLine(TURN, T0, { error: null }))).toMatchObject({
      outcome: { isError: false }
    })
  })

  it('reads a task_complete without a reply or an error as a turn with no outcome', () => {
    expect(parseRecord(taskCompleteLine(TURN, T0, { message: null }))).toEqual({
      kind: 'turn-completed',
      at: T0,
      outcome: null
    })
    expect(parseRecord(taskCompleteLine(TURN, T0, { message: '' }))).toMatchObject({
      outcome: null
    })
  })

  it('reads turn_aborted', () => {
    expect(parseRecord(turnAbortedLine(TURN, T0))).toEqual({ kind: 'turn-aborted', at: T0 })
  })

  it('reads prompts and replies from item_completed', () => {
    expect(parseRecord(userMessageLine('Synthetic prompt.', T0))).toEqual({
      kind: 'user-message',
      at: T0,
      text: 'Synthetic prompt.'
    })
    expect(parseRecord(agentMessageLine('Synthetic note.', T0, 'commentary'))).toEqual({
      kind: 'agent-message',
      at: T0,
      text: 'Synthetic note.'
    })
    expect(parseRecord(agentMessageLine('Synthetic answer.', T0))).toMatchObject({
      kind: 'agent-message'
    })
  })

  it('leaves out attached images and an item with no text', () => {
    const item = (content: unknown[]): string =>
      rolloutLine(
        'event_msg',
        { type: 'item_completed', item: { type: 'UserMessage', content } },
        T0
      )
    const withImage = item([
      { type: 'local_image', path: '/Users/synthetic/picture.png' },
      { type: 'text', text: 'Synthetic prompt.' }
    ])
    expect(parseRecord(withImage)).toMatchObject({
      kind: 'user-message',
      text: 'Synthetic prompt.'
    })
    expect(parseRecord(item([{ type: 'local_image', path: '/x.png' }]))).toEqual({
      kind: 'other',
      at: T0
    })
  })

  it('does not take text from response_item messages, which hold added context', () => {
    const context = responseMessageLine('user', '<environment_context>…</environment_context>', T0)
    expect(parseRecord(context)).toEqual({ kind: 'other', at: T0 })
    expect(parseRecord(responseMessageLine('assistant', 'Synthetic.', T0))).toEqual({
      kind: 'other',
      at: T0
    })
  })

  it('reads tool call names, never their input or output', () => {
    expect(parseRecord(toolCallLine('js', T0))).toEqual({ kind: 'tool-call', at: T0, name: 'js' })
    expect(parseRecord(toolCallLine('exec', T0, 'custom_tool_call'))).toEqual({
      kind: 'tool-call',
      at: T0,
      name: 'exec'
    })
    expect(parseRecord(toolCallLine(null, T0, 'web_search_call'))).toEqual({
      kind: 'tool-call',
      at: T0,
      name: 'web_search'
    })
    expect(parseRecord(toolOutputLine(T0))).toEqual({ kind: 'other', at: T0 })
  })

  it.each(['world_state', 'token_usage_record', 'compacted', 'brand_new_type'])(
    'reads the unknown record type %s as other activity',
    (type) => {
      expect(parseRecord(unknownLine(type, T0))).toEqual({ kind: 'other', at: T0 })
    }
  )

  it('reads an unknown event type as other activity', () => {
    const line = rolloutLine('event_msg', { type: 'token_count', info: {} }, T0)
    expect(parseRecord(line)).toEqual({ kind: 'other', at: T0 })
  })

  it.each([
    ['a malformed line', '{"timestamp":"2026-01-15T09:00:00.000Z","type":"event_'],
    ['a JSON array', '[1,2]'],
    ['a line without a timestamp', JSON.stringify({ type: 'event_msg', payload: {} })],
    ['a line with a bad timestamp', JSON.stringify({ timestamp: 'later', type: 'event_msg' })],
    ['a line without a type', JSON.stringify({ timestamp: new Date(T0).toISOString() })]
  ])('skips %s', (_name, line) => {
    expect(parseRecord(line)).toBeNull()
  })
})

describe('parseIndexLine', () => {
  it('reads the ID and name', () => {
    expect(parseIndexLine(indexLine(THREAD, 'Synthetic thread', T0))).toEqual({
      id: THREAD,
      title: 'Synthetic thread'
    })
  })

  it('treats a blank name as no title', () => {
    expect(parseIndexLine(indexLine(THREAD, '  ', T0))).toEqual({ id: THREAD, title: null })
  })

  it('skips a line without an ID, and a malformed line', () => {
    expect(parseIndexLine(JSON.stringify({ thread_name: 'Synthetic' }))).toBeNull()
    expect(parseIndexLine('{"id":')).toBeNull()
  })
})
