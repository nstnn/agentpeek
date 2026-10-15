import { describe, expect, it } from 'vitest'
import {
  isStoredId,
  parseStateFile,
  serializeStateFile,
  type StateFileData,
  type StoredSession
} from './state-file'

// Synthetic IDs and times only.
const T = 1_768_467_600_000

const CODEX: StoredSession = {
  tool: 'codex',
  id: '00000000-0000-4000-8000-0000000000a1',
  pinned: true,
  seenCursor: '00000000-0000-4000-8000-0000000000b1',
  acknowledgedErrorCursor: null,
  lastListedAt: T
}

const CLAUDE: StoredSession = {
  tool: 'claude',
  id: '00000000-0000-4000-8000-0000000000c1',
  pinned: false,
  seenCursor: null,
  acknowledgedErrorCursor: '00000000-0000-4000-8000-0000000000e1',
  lastListedAt: T - 1000
}

const DATA: StateFileData = { baselines: { codex: T, claude: T - 5000 }, sessions: [CODEX, CLAUDE] }

/** A valid file as plain JSON, with one change applied. */
function fileWith(change: (file: Record<string, unknown>) => void): string {
  const file = JSON.parse(serializeStateFile(DATA)) as Record<string, unknown>
  change(file)
  return JSON.stringify(file)
}

function firstSession(file: Record<string, unknown>): Record<string, unknown> {
  return (file.sessions as [Record<string, unknown>])[0]
}

describe('serializeStateFile and parseStateFile', () => {
  it('round-trips the state', () => {
    expect(parseStateFile(serializeStateFile(DATA))).toEqual({ kind: 'state', data: DATA })
  })

  it('round-trips an empty state', () => {
    const empty: StateFileData = { baselines: {}, sessions: [] }
    expect(serializeStateFile(empty)).toBe(
      '{\n  "version": 1,\n  "baselines": {},\n  "sessions": []\n}\n'
    )
    expect(parseStateFile(serializeStateFile(empty))).toEqual({ kind: 'state', data: empty })
  })

  it('reports a newer version without checking the rest', () => {
    expect(parseStateFile('{"version":2}')).toEqual({ kind: 'newer-version' })
    expect(parseStateFile('{"version":7,"sessions":"anything"}')).toEqual({ kind: 'newer-version' })
  })

  it.each([
    ['empty text', ''],
    ['not JSON', '{"version":1,'],
    ['an array', '[]'],
    ['null', 'null'],
    ['no version', '{"baselines":{},"sessions":[]}'],
    ['a text version', '{"version":"1","baselines":{},"sessions":[]}'],
    ['version 0', '{"version":0,"baselines":{},"sessions":[]}'],
    ['a fractional version', '{"version":1.5,"baselines":{},"sessions":[]}'],
    ['no baselines', fileWith((file) => delete file.baselines)],
    ['a negative baseline', fileWith((file) => (file.baselines = { codex: -1 }))],
    ['a text baseline', fileWith((file) => (file.baselines = { claude: 'today' }))],
    ['no sessions', fileWith((file) => delete file.sessions)],
    ['a session that is not an object', fileWith((file) => (file.sessions = ['x']))],
    ['an unknown tool', fileWith((file) => (firstSession(file).tool = 'other'))],
    ['a missing ID', fileWith((file) => delete firstSession(file).id)],
    ['a text pin', fileWith((file) => (firstSession(file).pinned = 'yes'))],
    ['a missing cursor', fileWith((file) => delete firstSession(file).seenCursor)],
    ['a missing listed time', fileWith((file) => delete firstSession(file).lastListedAt)],
    ['a session twice', fileWith((file) => (file.sessions = [CODEX, CLAUDE, CODEX]))]
  ])('reports %s as unreadable', (_name, text) => {
    expect(parseStateFile(text)).toEqual({ kind: 'unreadable' })
  })

  it('ignores keys it does not know, and does not write them back', () => {
    const text = fileWith((file) => {
      file.extra = 'x'
      firstSession(file).extra = 'x'
    })
    const parsed = parseStateFile(text)
    expect(parsed).toEqual({ kind: 'state', data: DATA })
    if (parsed.kind !== 'state') return
    expect(serializeStateFile(parsed.data)).not.toContain('extra')
  })
})

describe('no field can hold message text', () => {
  const TEXT_LIKE = [
    'Synthetic reply: the folder holds two files.',
    'line one\nline two',
    'x'.repeat(201),
    'Ünïcode',
    ''
  ]

  it.each(TEXT_LIKE)('refuses %j as an ID or a cursor', (text) => {
    expect(isStoredId(text)).toBe(false)
    for (const field of ['id', 'seenCursor', 'acknowledgedErrorCursor']) {
      expect(parseStateFile(fileWith((file) => (firstSession(file)[field] = text)))).toEqual({
        kind: 'unreadable'
      })
    }
  })

  it('accepts the IDs and cursors the tools use', () => {
    expect(isStoredId('00000000-0000-4000-8000-0000000000a1')).toBe(true)
    expect(isStoredId('x'.repeat(200))).toBe(true)
  })

  it('writes only known keys, flags, times, tool names, and ID-shaped strings', () => {
    // Even a session object carrying extra properties at run time writes only the known fields.
    const sneaky = { ...CODEX, title: 'Synthetic title', text: 'Synthetic reply.' } as StoredSession
    const written = JSON.parse(serializeStateFile({ ...DATA, sessions: [sneaky] })) as unknown
    const keys = new Set([
      'version',
      'baselines',
      'sessions',
      'codex',
      'claude',
      'tool',
      'id',
      'pinned',
      'seenCursor',
      'acknowledgedErrorCursor',
      'lastListedAt'
    ])
    const strings: string[] = []
    const visit = (value: unknown): void => {
      // Null is an empty cursor.
      if (value === null) return
      if (typeof value === 'string') strings.push(value)
      else if (Array.isArray(value)) value.forEach(visit)
      else if (typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) {
          expect(keys).toContain(key)
          visit(child)
        }
      } else expect(['number', 'boolean']).toContain(typeof value)
    }
    visit(written)
    for (const value of strings) {
      expect(value === 'codex' || value === 'claude' || isStoredId(value)).toBe(true)
    }
  })
})
