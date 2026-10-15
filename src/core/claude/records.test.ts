import { describe, expect, it } from 'vitest'
import {
  DENIED_MARKER,
  parseCatalogFile,
  parseRecord,
  parseRegistryFile,
  STOP_MARKER
} from './records'
import {
  apiErrorLine,
  assistantLine,
  bookkeepingLine,
  catalogJson,
  customTitleLine,
  interruptLine,
  metaUserLine,
  promptLine,
  registryJson,
  SECOND,
  stopHookSummaryLine,
  syntheticId,
  T0,
  timedLine,
  toolResultLine,
  VERSION
} from './test-records'

const SESSION = syntheticId(1)

describe('parseCatalogFile', () => {
  it('picks only the fields AgentPeek uses', () => {
    const result = parseCatalogFile(
      catalogJson({ cliSessionId: SESSION, title: '  Synthetic session  ', lastActivityAt: T0 })
    )
    // Exactly these keys: the settings in the file (permissions, MCP servers) are never kept.
    expect(result).toEqual({
      kind: 'entry',
      entry: {
        cliSessionId: SESSION,
        title: 'Synthetic session',
        cwd: '/Users/synthetic/projects/demo',
        isArchived: false,
        lastActivityAt: T0
      }
    })
  })

  it('reads an archived entry and an entry without a title', () => {
    expect(
      parseCatalogFile(catalogJson({ cliSessionId: SESSION, title: null, isArchived: true }))
    ).toMatchObject({ kind: 'entry', entry: { title: null, isArchived: true } })
    expect(parseCatalogFile(catalogJson({ cliSessionId: SESSION, title: '   ' }))).toMatchObject({
      entry: { title: null }
    })
  })

  it('treats unexpected field types as missing', () => {
    const text = JSON.stringify({
      cliSessionId: SESSION,
      title: 42,
      cwd: [],
      isArchived: 'yes',
      lastActivityAt: '2026-01-15T09:00:00Z'
    })
    expect(parseCatalogFile(text)).toEqual({
      kind: 'entry',
      entry: {
        cliSessionId: SESSION,
        title: null,
        cwd: null,
        isArchived: false,
        lastActivityAt: null
      }
    })
  })

  it('does not recognize a file without a CLI session ID', () => {
    expect(parseCatalogFile(JSON.stringify({ title: 'Synthetic' }))).toEqual({
      kind: 'unrecognized'
    })
    expect(parseCatalogFile('[]')).toEqual({ kind: 'unrecognized' })
    expect(parseCatalogFile('{"cliSessionId": ""}')).toEqual({ kind: 'unrecognized' })
  })

  it('reports text that is not JSON', () => {
    expect(parseCatalogFile('{"cliSessionId": "x"')).toEqual({ kind: 'malformed' })
    expect(parseCatalogFile('')).toEqual({ kind: 'malformed' })
  })
})

describe('parseRegistryFile', () => {
  it('reads the fields AgentPeek uses and ignores the rest', () => {
    const text = registryJson({
      pid: 4242,
      sessionId: SESSION,
      status: 'waiting',
      waitingFor: 'permission prompt',
      updatedAt: T0 + SECOND
    })
    expect(parseRegistryFile(text)).toEqual({
      kind: 'entry',
      entry: {
        pid: 4242,
        sessionId: SESSION,
        cwd: '/Users/synthetic/projects/demo',
        name: 'Synthetic session',
        status: 'waiting',
        waitingFor: 'permission prompt',
        updatedAt: T0 + SECOND,
        procStart: 'Thu Jan 15 09:00:00 2026',
        version: VERSION
      }
    })
  })

  it('reads each status, and no status while the process starts', () => {
    for (const status of ['busy', 'waiting', 'idle'] as const) {
      expect(parseRegistryFile(registryJson({ pid: 1, sessionId: SESSION, status }))).toMatchObject(
        { entry: { status } }
      )
    }
    expect(
      parseRegistryFile(registryJson({ pid: 1, sessionId: SESSION, status: null }))
    ).toMatchObject({ entry: { status: null } })
  })

  it('marks a status AgentPeek does not know', () => {
    expect(
      parseRegistryFile(registryJson({ pid: 1, sessionId: SESSION, status: 'compacting' }))
    ).toMatchObject({ entry: { status: 'unrecognized' } })
  })

  it('reads an entry without a start time', () => {
    expect(
      parseRegistryFile(registryJson({ pid: 1, sessionId: SESSION, procStart: null }))
    ).toMatchObject({ entry: { procStart: null } })
  })

  it('does not recognize an entry without a usable process ID or session ID', () => {
    for (const pid of [0, -1, 1.5, '4242', null]) {
      expect(
        parseRegistryFile(JSON.stringify({ pid, sessionId: SESSION, version: VERSION }))
      ).toEqual({ kind: 'unrecognized', version: VERSION })
    }
    expect(parseRegistryFile(JSON.stringify({ pid: 4242 }))).toEqual({
      kind: 'unrecognized',
      version: null
    })
    expect(parseRegistryFile('"text"')).toEqual({ kind: 'unrecognized', version: null })
  })

  it('reports a file caught half-written', () => {
    expect(parseRegistryFile('{"pid":4242,"sess')).toEqual({ kind: 'malformed' })
    expect(parseRegistryFile('')).toEqual({ kind: 'malformed' })
  })
})

describe('parseRecord', () => {
  it('reads a prompt the user typed, as a string or as text parts', () => {
    expect(parseRecord(promptLine('Synthetic prompt.', T0))).toEqual({
      kind: 'prompt',
      at: T0,
      version: VERSION,
      text: 'Synthetic prompt.'
    })
    expect(
      parseRecord(promptLine('Synthetic prompt.', T0, { asParts: true, origin: null }))
    ).toMatchObject({ kind: 'prompt', text: 'Synthetic prompt.' })
  })

  it('reads a slash command or a shell command the user ran as a prompt', () => {
    const command =
      '<command-message>synthetic</command-message>\n<command-name>/synthetic</command-name>'
    const shell = '<bash-input>echo synthetic</bash-input>'
    for (const text of [command, shell]) {
      for (const origin of ['human', null]) {
        expect(parseRecord(promptLine(text, T0, { origin }))).toMatchObject({
          kind: 'prompt',
          text
        })
      }
    }
  })

  it('keeps the output of a slash command or a shell command only as activity', () => {
    for (const tag of [
      'local-command-stdout',
      'local-command-stderr',
      'bash-stdout',
      'bash-stderr'
    ]) {
      const output = `<${tag}>Synthetic output.</${tag}>`
      for (const text of [output, `\n${output}`]) {
        for (const origin of [null, 'human']) {
          for (const asParts of [false, true]) {
            expect(parseRecord(promptLine(text, T0, { origin, asParts }))).toEqual({
              kind: 'other',
              at: T0,
              version: VERSION
            })
          }
        }
      }
    }
    // Anywhere but at the start, the tag is the user's own text.
    const quoted = 'Why does <bash-stdout> appear here?'
    expect(parseRecord(promptLine(quoted, T0))).toMatchObject({ kind: 'prompt', text: quoted })
  })

  it('does not take messages the user did not type as prompts', () => {
    for (const origin of ['task-notification', 'peer', 'something-new']) {
      expect(parseRecord(promptLine('Synthetic message.', T0, { origin }))).toEqual({
        kind: 'other',
        at: T0,
        version: VERSION
      })
    }
    expect(parseRecord(metaUserLine('Synthetic caveat.', T0, { isMeta: true }))).toMatchObject({
      kind: 'other'
    })
    expect(
      parseRecord(
        metaUserLine('Synthetic summary.', T0, {
          isCompactSummary: true,
          isVisibleInTranscriptOnly: true
        })
      )
    ).toMatchObject({ kind: 'other' })
    // Each flag on its own is enough.
    for (const flag of ['isCompactSummary', 'isVisibleInTranscriptOnly']) {
      expect(parseRecord(metaUserLine('Synthetic.', T0, { [flag]: true }))).toMatchObject({
        kind: 'other'
      })
    }
    expect(parseRecord(toolResultLine(T0))).toMatchObject({ kind: 'other' })
    expect(parseRecord(toolResultLine(T0, true))).toMatchObject({ kind: 'other' })
    // A tool result that also carries text is still not a prompt.
    const withText = JSON.parse(toolResultLine(T0)) as { message: { content: object[] } }
    withText.message.content.push({ type: 'text', text: 'Synthetic note.' })
    expect(parseRecord(JSON.stringify(withText))).toMatchObject({ kind: 'other' })
    expect(parseRecord(promptLine('   ', T0))).toMatchObject({ kind: 'other' })
  })

  it('matches the interrupt markers exactly', () => {
    expect(parseRecord(interruptLine(STOP_MARKER, T0))).toEqual({
      kind: 'interrupt',
      at: T0,
      version: VERSION
    })
    expect(parseRecord(interruptLine(DENIED_MARKER, T0))).toMatchObject({ kind: 'interrupt' })
    // Anything else is the user's own text.
    expect(parseRecord(promptLine(`${STOP_MARKER} please`, T0))).toMatchObject({ kind: 'prompt' })
  })

  it('reads an assistant record: its text, its tool calls, and whether it ends the turn', () => {
    expect(
      parseRecord(
        assistantLine(
          [
            { type: 'thinking', thinking: 'Synthetic thinking.' },
            { type: 'text', text: 'Synthetic answer.' },
            { type: 'tool_use', name: 'Bash' }
          ],
          T0,
          { uuid: syntheticId(9), stopReason: 'tool_use' }
        )
      )
    ).toEqual({
      kind: 'assistant',
      at: T0,
      version: VERSION,
      uuid: syntheticId(9),
      text: 'Synthetic answer.',
      toolNames: ['Bash'],
      endsTurn: false
    })
    expect(parseRecord(assistantLine([{ type: 'text', text: 'Synthetic.' }], T0))).toMatchObject({
      kind: 'assistant',
      endsTurn: true
    })
    // A message still streaming, or one that stopped some other way.
    expect(
      parseRecord(assistantLine([{ type: 'text', text: 'Synthetic.' }], T0, { stopReason: null }))
    ).toMatchObject({ kind: 'assistant', endsTurn: false })
    expect(
      parseRecord(assistantLine([{ type: 'thinking', thinking: 'Synthetic.' }], T0))
    ).toMatchObject({ kind: 'assistant', text: '', toolNames: [], endsTurn: true })
  })

  it('reads an API error with its error code', () => {
    expect(parseRecord(apiErrorLine('rate_limit', T0, syntheticId(7)))).toEqual({
      kind: 'api-error',
      at: T0,
      version: VERSION,
      uuid: syntheticId(7),
      errorCode: 'rate_limit'
    })
    const withoutCode = JSON.parse(apiErrorLine('rate_limit', T0)) as Record<string, unknown>
    delete withoutCode.error
    expect(parseRecord(JSON.stringify(withoutCode))).toMatchObject({
      kind: 'api-error',
      errorCode: null
    })
  })

  it('reads the custom title', () => {
    expect(parseRecord(customTitleLine(' Synthetic title '))).toEqual({
      kind: 'custom-title',
      at: null,
      version: null,
      title: 'Synthetic title'
    })
    expect(parseRecord(customTitleLine(''))).toMatchObject({ kind: 'custom-title', title: null })
  })

  it('keeps other records only as activity', () => {
    expect(parseRecord(stopHookSummaryLine(T0))).toEqual({
      kind: 'other',
      at: T0,
      version: VERSION
    })
    expect(parseRecord(timedLine('pr-link', T0))).toMatchObject({ kind: 'other', at: T0 })
    expect(parseRecord(bookkeepingLine('agent-name'))).toEqual({
      kind: 'other',
      at: null,
      version: null
    })
  })

  it('treats conversation records without a time, and sidechain records, as other records', () => {
    const noTime = JSON.parse(promptLine('Synthetic.', T0)) as Record<string, unknown>
    delete noTime.timestamp
    expect(parseRecord(JSON.stringify(noTime))).toMatchObject({ kind: 'other', at: null })
    const badTime = { ...noTime, timestamp: 'yesterday' }
    expect(parseRecord(JSON.stringify(badTime))).toMatchObject({ kind: 'other', at: null })
    for (const line of [
      promptLine('Synthetic.', T0),
      assistantLine([{ type: 'text', text: 'Synthetic.' }], T0)
    ]) {
      const sidechain = { ...(JSON.parse(line) as object), isSidechain: true }
      expect(parseRecord(JSON.stringify(sidechain))).toMatchObject({ kind: 'other', at: T0 })
    }
  })

  it('skips lines that are not records', () => {
    for (const line of ['not json', '{"type": 1}', '[]', 'null', '{"message": {}}', '{"type":']) {
      expect(parseRecord(line)).toBeNull()
    }
  })
})
