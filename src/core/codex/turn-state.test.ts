import { describe, expect, it } from 'vitest'
import { codexSessionFacts, type CodexFactsInput } from './facts'
import { codexMessages } from './messages'
import { type CodexRecord, parseRecord } from './records'
import {
  agentMessageLine,
  MINUTE,
  SECOND,
  syntheticId,
  T0,
  taskCompleteLine,
  taskStartedLine,
  toolCallLine,
  turnAbortedLine,
  unknownLine,
  userMessageLine
} from './test-records'
import { type CodexTurnState, EMPTY_CODEX_TURN_STATE, foldCodexRecords } from './turn-state'

// Synthetic lines only. Turn IDs: A, B, C in time order.
const A = syntheticId(0xa)
const B = syntheticId(0xb)
const C = syntheticId(0xc)

function records(lines: readonly string[]): CodexRecord[] {
  return lines.map((line) => {
    const record = parseRecord(line)
    if (record === null) throw new Error('A test line did not parse.')
    return record
  })
}

function fold(lines: readonly string[]): CodexTurnState {
  return foldCodexRecords(EMPTY_CODEX_TURN_STATE, records(lines))
}

describe('foldCodexRecords', () => {
  it('starts with nothing known', () => {
    expect(fold([])).toEqual({ lastTurnEvent: null, lastReply: null, lastRecordAt: null })
  })

  it('reports an open turn as started', () => {
    expect(fold([taskStartedLine(A, T0), userMessageLine('Synthetic.', T0 + SECOND)])).toEqual({
      lastTurnEvent: 'started',
      lastReply: null,
      lastRecordAt: T0 + SECOND
    })
  })

  it('reports a completed turn with its final reply', () => {
    const state = fold([taskStartedLine(A, T0), taskCompleteLine(A, T0 + MINUTE)])
    expect(state).toEqual({
      lastTurnEvent: 'ended',
      lastReply: {
        cursor: A,
        completedAt: T0 + MINUTE,
        isError: false,
        errorCode: null,
        newerTurnStarted: false
      },
      lastRecordAt: T0 + MINUTE
    })
  })

  it('reports a completed turn with an error', () => {
    const state = fold([
      taskStartedLine(A, T0),
      taskCompleteLine(A, T0 + MINUTE, {
        message: null,
        error: { codex_error_info: 'server_overloaded', message: 'Synthetic error.' }
      })
    ])
    expect(state.lastReply).toMatchObject({
      cursor: A,
      isError: true,
      errorCode: 'server_overloaded',
      newerTurnStarted: false
    })
  })

  it('replaces an error with a newer successful reply', () => {
    const state = fold([
      taskStartedLine(A, T0),
      taskCompleteLine(A, T0 + MINUTE, { message: null, error: { codex_error_info: 'x' } }),
      taskStartedLine(B, T0 + 2 * MINUTE),
      taskCompleteLine(B, T0 + 3 * MINUTE)
    ])
    expect(state.lastReply).toMatchObject({ cursor: B, isError: false, newerTurnStarted: false })
  })

  it('marks the reply when a newer turn starts, and keeps it while that turn runs', () => {
    const state = fold([
      taskStartedLine(A, T0),
      taskCompleteLine(A, T0 + MINUTE),
      taskStartedLine(B, T0 + 2 * MINUTE)
    ])
    expect(state.lastTurnEvent).toBe('started')
    expect(state.lastReply).toMatchObject({ cursor: A, newerTurnStarted: true })
  })

  it('gives a stopped turn no reply, but its start still marks the earlier reply', () => {
    const state = fold([
      taskStartedLine(A, T0),
      taskCompleteLine(A, T0 + MINUTE),
      taskStartedLine(B, T0 + 2 * MINUTE),
      turnAbortedLine(B, T0 + 3 * MINUTE)
    ])
    expect(state.lastTurnEvent).toBe('ended')
    expect(state.lastReply).toMatchObject({ cursor: A, newerTurnStarted: true })
  })

  it('gives a turn that ended without a message no reply', () => {
    const state = fold([
      taskStartedLine(A, T0),
      taskCompleteLine(A, T0 + MINUTE),
      taskStartedLine(B, T0 + 2 * MINUTE),
      taskCompleteLine(B, T0 + 3 * MINUTE, { message: null })
    ])
    expect(state.lastTurnEvent).toBe('ended')
    expect(state.lastReply).toMatchObject({ cursor: A, newerTurnStarted: true })
  })

  it('uses the last turn event even when a tail starts in the middle of a turn', () => {
    expect(fold([taskCompleteLine(A, T0)]).lastTurnEvent).toBe('ended')
    expect(fold([unknownLine('world_state', T0)]).lastTurnEvent).toBeNull()
  })

  it('gives the same state when the lines arrive in batches', () => {
    const lines = [
      taskStartedLine(A, T0),
      taskCompleteLine(A, T0 + MINUTE),
      taskStartedLine(B, T0 + 2 * MINUTE),
      turnAbortedLine(B, T0 + 3 * MINUTE),
      taskStartedLine(C, T0 + 4 * MINUTE)
    ]
    const all = fold(lines)
    for (let split = 0; split <= lines.length; split++) {
      const first = fold(lines.slice(0, split))
      expect(foldCodexRecords(first, records(lines.slice(split)))).toEqual(all)
    }
  })

  it('does not change the state it was given', () => {
    const before = fold([taskStartedLine(A, T0), taskCompleteLine(A, T0 + MINUTE)])
    const copy = structuredClone(before)
    foldCodexRecords(before, records([taskStartedLine(B, T0 + 2 * MINUTE)]))
    expect(before).toEqual(copy)
  })
})

describe('codexMessages', () => {
  it('lists prompts and replies, and one line per run of tool calls', () => {
    const messages = codexMessages(
      records([
        taskStartedLine(A, T0),
        userMessageLine('Synthetic prompt.', T0 + 1 * SECOND),
        agentMessageLine('Synthetic note.', T0 + 2 * SECOND, 'commentary'),
        toolCallLine('exec', T0 + 3 * SECOND, 'custom_tool_call'),
        toolCallLine('js', T0 + 4 * SECOND),
        toolCallLine('exec', T0 + 5 * SECOND, 'custom_tool_call'),
        agentMessageLine('Synthetic answer.', T0 + 6 * SECOND),
        toolCallLine('js', T0 + 7 * SECOND),
        taskCompleteLine(A, T0 + 8 * SECOND)
      ])
    )
    expect(messages).toEqual([
      { kind: 'prompt', text: 'Synthetic prompt.', at: T0 + 1 * SECOND },
      { kind: 'reply', text: 'Synthetic note.', at: T0 + 2 * SECOND },
      { kind: 'tool-calls', count: 3, names: ['exec', 'js'], at: T0 + 3 * SECOND },
      { kind: 'reply', text: 'Synthetic answer.', at: T0 + 6 * SECOND },
      { kind: 'tool-calls', count: 1, names: ['js'], at: T0 + 7 * SECOND }
    ])
  })

  it('returns nothing for records without messages', () => {
    expect(
      codexMessages(records([taskStartedLine(A, T0), unknownLine('world_state', T0)]))
    ).toEqual([])
  })
})

describe('codexSessionFacts', () => {
  const input: CodexFactsInput = {
    meta: {
      id: A,
      isUserThread: true,
      cwd: '/Users/synthetic/projects/demo',
      cliVersion: '0.162.0'
    },
    title: 'Synthetic thread',
    state: fold([taskStartedLine(B, T0)]),
    fileStatus: 'read',
    fileModifiedAt: T0 - MINUTE,
    appRunning: false
  }

  it('reports the summary, the turn, and the reply', () => {
    expect(codexSessionFacts(input)).toEqual({
      key: { tool: 'codex', id: A },
      summary: {
        title: 'Synthetic thread',
        workspacePath: '/Users/synthetic/projects/demo',
        lastActivityAt: T0,
        toolVersion: '0.162.0'
      },
      turn: { kind: 'codex', lastTurnEvent: 'started', appRunning: false },
      lastReply: null
    })
  })

  it('falls back to the file time when no record was read', () => {
    const facts = codexSessionFacts({ ...input, state: EMPTY_CODEX_TURN_STATE })
    expect(facts.summary.lastActivityAt).toBe(T0 - MINUTE)
    expect(facts.turn).toEqual({ kind: 'codex', lastTurnEvent: null, appRunning: false })
  })

  it.each(['unreadable', 'unsupported'] as const)('reports an %s file', (fileStatus) => {
    expect(codexSessionFacts({ ...input, fileStatus }).turn).toEqual({ kind: fileStatus })
  })
})
