import { describe, expect, it } from 'vitest'
import { claudeSessionFacts, type ClaudeFactsInput } from './facts'
import { claudeMessages } from './messages'
import {
  type ClaudeRecord,
  type ClaudeRegistryEntry,
  DENIED_MARKER,
  parseRecord,
  STOP_MARKER
} from './records'
import {
  apiErrorLine,
  assistantLine,
  bookkeepingLine,
  customTitleLine,
  interruptLine,
  MINUTE,
  promptLine,
  SECOND,
  syntheticId,
  T0,
  toolResultLine,
  VERSION
} from './test-records'
import {
  type ClaudeTranscriptState,
  EMPTY_CLAUDE_TRANSCRIPT_STATE,
  foldClaudeRecords,
  marksTurn
} from './transcript-state'

// Synthetic lines only. Record UUIDs: R1, R2, R3 in time order.
const R1 = syntheticId(0x1)
const R2 = syntheticId(0x2)
const R3 = syntheticId(0x3)

function records(lines: readonly string[]): ClaudeRecord[] {
  return lines.map((line) => {
    const record = parseRecord(line)
    if (record === null) throw new Error('A test line did not parse.')
    return record
  })
}

function fold(lines: readonly string[]): ClaudeTranscriptState {
  return foldClaudeRecords(EMPTY_CLAUDE_TRANSCRIPT_STATE, records(lines))
}

function reply(uuid: string, text: string, at: number): string {
  return assistantLine([{ type: 'text', text }], at, { uuid })
}

describe('foldClaudeRecords', () => {
  it('starts with nothing known', () => {
    expect(fold([])).toEqual({
      lastReply: null,
      customTitle: null,
      lastRecordAt: null,
      version: null
    })
  })

  it('reports a final reply, using its last record as the cursor', () => {
    const state = fold([
      promptLine('Synthetic prompt.', T0),
      assistantLine([{ type: 'thinking', thinking: 'Synthetic.' }], T0 + SECOND, { uuid: R1 }),
      reply(R2, 'Synthetic answer.', T0 + SECOND)
    ])
    expect(state).toEqual({
      lastReply: {
        cursor: R2,
        completedAt: T0 + SECOND,
        isError: false,
        errorCode: null,
        newerTurnStarted: false
      },
      customTitle: null,
      lastRecordAt: T0 + SECOND,
      version: VERSION
    })
  })

  it('does not take tool calls or text before them as a final reply', () => {
    const state = fold([
      promptLine('Synthetic prompt.', T0),
      assistantLine([{ type: 'text', text: 'Synthetic note.' }], T0 + SECOND, {
        uuid: R1,
        stopReason: 'tool_use'
      }),
      assistantLine([{ type: 'tool_use', name: 'Bash' }], T0 + SECOND, {
        uuid: R2,
        stopReason: 'tool_use'
      }),
      toolResultLine(T0 + 2 * SECOND)
    ])
    expect(state.lastReply).toBeNull()
    expect(state.lastRecordAt).toBe(T0 + 2 * SECOND)
  })

  it('reports an API error as an error reply', () => {
    const state = fold([promptLine('Synthetic.', T0), apiErrorLine('rate_limit', T0 + MINUTE, R1)])
    expect(state.lastReply).toEqual({
      cursor: R1,
      completedAt: T0 + MINUTE,
      isError: true,
      errorCode: 'rate_limit',
      newerTurnStarted: false
    })
  })

  it('marks the reply when the user starts a newer turn', () => {
    const state = fold([
      reply(R1, 'Synthetic answer.', T0),
      promptLine('Synthetic follow-up.', T0 + MINUTE)
    ])
    expect(state.lastReply).toMatchObject({ cursor: R1, newerTurnStarted: true })
  })

  it('marks an error when the user starts a newer turn', () => {
    const state = fold([apiErrorLine('server_error', T0, R1), promptLine('Again.', T0 + MINUTE)])
    expect(state.lastReply).toMatchObject({ cursor: R1, isError: true, newerTurnStarted: true })
  })

  it('replaces an error with a newer reply', () => {
    const state = fold([
      apiErrorLine('rate_limit', T0, R1),
      promptLine('Again.', T0 + MINUTE),
      reply(R2, 'Synthetic answer.', T0 + 2 * MINUTE)
    ])
    expect(state.lastReply).toMatchObject({ cursor: R2, isError: false, newerTurnStarted: false })
  })

  it('produces no reply for a stopped turn, and keeps the earlier one as seen', () => {
    const state = fold([
      reply(R1, 'Synthetic answer.', T0),
      promptLine('Synthetic long task.', T0 + MINUTE),
      interruptLine(STOP_MARKER, T0 + 2 * MINUTE)
    ])
    expect(state.lastReply).toMatchObject({ cursor: R1, newerTurnStarted: true })
  })

  it('produces no reply or error for a denied permission', () => {
    const state = fold([
      promptLine('Synthetic task.', T0),
      assistantLine([{ type: 'tool_use', name: 'WebFetch' }], T0 + SECOND, {
        uuid: R1,
        stopReason: 'tool_use'
      }),
      toolResultLine(T0 + 2 * SECOND, true),
      interruptLine(DENIED_MARKER, T0 + 2 * SECOND)
    ])
    expect(state.lastReply).toBeNull()
  })

  it('does not let a background task message mark the reply as seen', () => {
    const state = fold([
      reply(R1, 'Synthetic answer.', T0),
      promptLine('<task-notification>Synthetic.</task-notification>', T0 + MINUTE, {
        origin: 'task-notification'
      }),
      reply(R2, 'Synthetic note.', T0 + 2 * MINUTE)
    ])
    expect(state.lastReply).toMatchObject({ cursor: R2, newerTurnStarted: false })
  })

  it('keeps the last custom title and version, and the newest time', () => {
    const state = fold([
      customTitleLine('First title'),
      reply(R1, 'Synthetic.', T0 + MINUTE),
      bookkeepingLine('agent-name'),
      customTitleLine('Second title')
    ])
    expect(state).toMatchObject({
      customTitle: 'Second title',
      lastRecordAt: T0 + MINUTE,
      version: VERSION
    })
  })

  it('continues from an earlier state', () => {
    const first = fold([reply(R1, 'Synthetic.', T0)])
    const next = foldClaudeRecords(first, records([promptLine('Again.', T0 + MINUTE)]))
    expect(next.lastReply).toMatchObject({ cursor: R1, newerTurnStarted: true })
    expect(next.lastRecordAt).toBe(T0 + MINUTE)
  })
})

describe('marksTurn', () => {
  it('is true for prompts and the ends of turns only', () => {
    const marks = records([
      promptLine('Synthetic.', T0),
      assistantLine([{ type: 'tool_use', name: 'Bash' }], T0, { stopReason: 'tool_use' }),
      toolResultLine(T0),
      reply(R1, 'Synthetic.', T0),
      apiErrorLine('rate_limit', T0),
      interruptLine(STOP_MARKER, T0),
      customTitleLine('Synthetic'),
      bookkeepingLine('mode')
    ]).map(marksTurn)
    expect(marks).toEqual([true, false, false, true, true, true, false, false])
  })
})

describe('claudeMessages', () => {
  it('lists prompts, replies, and one line per run of tool calls', () => {
    const messages = claudeMessages(
      records([
        promptLine('Synthetic prompt.', T0),
        assistantLine([{ type: 'thinking', thinking: 'Synthetic.' }], T0 + 1 * SECOND),
        assistantLine([{ type: 'text', text: 'Synthetic note.' }], T0 + 2 * SECOND),
        assistantLine([{ type: 'tool_use', name: 'Read' }], T0 + 3 * SECOND),
        toolResultLine(T0 + 4 * SECOND),
        assistantLine(
          [
            { type: 'tool_use', name: 'Edit' },
            { type: 'tool_use', name: 'Read' }
          ],
          T0 + 5 * SECOND
        ),
        toolResultLine(T0 + 6 * SECOND),
        reply(R1, 'Synthetic answer.', T0 + 7 * SECOND)
      ])
    )
    expect(messages).toEqual([
      { kind: 'prompt', text: 'Synthetic prompt.', at: T0 },
      { kind: 'reply', text: 'Synthetic note.', at: T0 + 2 * SECOND },
      { kind: 'tool-calls', count: 3, names: ['Read', 'Edit'], at: T0 + 3 * SECOND },
      { kind: 'reply', text: 'Synthetic answer.', at: T0 + 7 * SECOND }
    ])
  })

  it('leaves out API errors, interrupts, and messages the user did not type', () => {
    const messages = claudeMessages(
      records([
        promptLine('Synthetic prompt.', T0),
        interruptLine(STOP_MARKER, T0 + SECOND),
        promptLine('Synthetic notice.', T0 + 2 * SECOND, { origin: 'task-notification' }),
        apiErrorLine('rate_limit', T0 + 3 * SECOND)
      ])
    )
    expect(messages).toEqual([{ kind: 'prompt', text: 'Synthetic prompt.', at: T0 }])
  })
})

describe('claudeSessionFacts', () => {
  const registry: ClaudeRegistryEntry = {
    pid: 4242,
    sessionId: syntheticId(1),
    cwd: '/Users/synthetic/registry',
    name: 'Registry name',
    status: 'busy',
    waitingFor: null,
    updatedAt: T0,
    procStart: null,
    version: '2.1.300'
  }

  function input(overrides: Partial<ClaudeFactsInput> = {}): ClaudeFactsInput {
    return {
      sessionId: syntheticId(1),
      catalog: {
        cliSessionId: syntheticId(1),
        title: 'Catalog title',
        cwd: '/Users/synthetic/catalog',
        isArchived: false,
        lastActivityAt: T0 + MINUTE
      },
      registry: null,
      ownerAlive: true,
      transcript: {
        lastReply: null,
        customTitle: 'Custom title',
        lastRecordAt: T0,
        version: VERSION
      },
      transcriptStatus: 'read',
      transcriptModifiedAt: T0 + 5 * MINUTE,
      ...overrides
    }
  }

  it('builds the summary from the catalog, the registry, and the transcript', () => {
    expect(claudeSessionFacts(input())).toEqual({
      key: { tool: 'claude', id: syntheticId(1) },
      summary: {
        title: 'Catalog title',
        workspacePath: '/Users/synthetic/catalog',
        lastActivityAt: T0 + MINUTE,
        toolVersion: VERSION
      },
      turn: { kind: 'claude', registry: null },
      lastReply: null
    })
  })

  it('takes the title from the catalog, then the registry, then the custom title', () => {
    const noCatalog = input({ catalog: null })
    expect(claudeSessionFacts({ ...noCatalog, registry }).summary).toMatchObject({
      title: 'Registry name',
      workspacePath: '/Users/synthetic/registry',
      toolVersion: '2.1.300'
    })
    expect(claudeSessionFacts(noCatalog).summary).toMatchObject({
      title: 'Custom title',
      workspacePath: null
    })
    const untitled = { ...noCatalog.transcript, customTitle: null }
    expect(claudeSessionFacts({ ...noCatalog, transcript: untitled }).summary.title).toBeNull()
  })

  it('takes the newest of the catalog time and the last record time', () => {
    const later = { ...input().transcript, lastRecordAt: T0 + 2 * MINUTE }
    expect(claudeSessionFacts(input({ transcript: later })).summary.lastActivityAt).toBe(
      T0 + 2 * MINUTE
    )
    const unknown = { ...input().transcript, lastRecordAt: null }
    expect(
      claudeSessionFacts(input({ catalog: null, transcript: unknown })).summary.lastActivityAt
    ).toBe(T0 + 5 * MINUTE)
  })

  it('reports the registry status, with the waiting detail only while waiting', () => {
    expect(claudeSessionFacts(input({ registry, ownerAlive: false })).turn).toEqual({
      kind: 'claude',
      registry: { status: 'busy', waitingFor: null, ownerAlive: false }
    })
    const waiting = { ...registry, status: 'waiting' as const, waitingFor: 'input needed' }
    expect(claudeSessionFacts(input({ registry: waiting })).turn).toEqual({
      kind: 'claude',
      registry: { status: 'waiting', waitingFor: 'input needed', ownerAlive: true }
    })
    const idle = { ...registry, status: 'idle' as const, waitingFor: 'input needed' }
    expect(claudeSessionFacts(input({ registry: idle })).turn).toMatchObject({
      registry: { status: 'idle', waitingFor: null }
    })
    const starting = { ...registry, status: null }
    expect(claudeSessionFacts(input({ registry: starting })).turn).toMatchObject({
      registry: { status: null }
    })
  })

  it('reports a status or a transcript AgentPeek cannot use', () => {
    const unknownStatus = { ...registry, status: 'unrecognized' as const }
    expect(claudeSessionFacts(input({ registry: unknownStatus })).turn).toEqual({
      kind: 'unsupported'
    })
    expect(claudeSessionFacts(input({ transcriptStatus: 'unsupported' })).turn).toEqual({
      kind: 'unsupported'
    })
    expect(claudeSessionFacts(input({ registry, transcriptStatus: 'unreadable' })).turn).toEqual({
      kind: 'unreadable'
    })
  })

  it('passes the last reply through', () => {
    const lastReply = {
      cursor: R3,
      completedAt: T0,
      isError: false,
      errorCode: null,
      newerTurnStarted: false
    }
    const transcript = { ...input().transcript, lastReply }
    expect(claudeSessionFacts(input({ transcript })).lastReply).toBe(lastReply)
  })
})
