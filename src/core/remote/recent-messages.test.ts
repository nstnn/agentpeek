import { describe, expect, it } from 'vitest'
import type { RecentMessages, SessionMessage } from '../session'
import {
  decodeMessages,
  PROTOCOL_VERSION,
  REMOTE_LIMITS,
  serializedTextBytes,
  type MessageEntry,
  type MessagesResult
} from './protocol'
import { cleanMessageText, projectRecentMessages } from './recent-messages'

// Protocol v2 budget and cleaning vectors (TASK-032). Synthetic text only.

const reply = (text: string, at = 1): SessionMessage => ({ kind: 'reply', text, at })
const prompt = (text: string, at = 1): SessionMessage => ({ kind: 'prompt', text, at })

function read(messages: SessionMessage[], hasOlder = false): RecentMessages {
  return { kind: 'messages', messages, hasOlder }
}

function entries(result: MessagesResult | 'not-found'): MessageEntry[] {
  if (result === 'not-found' || result.state !== 'messages') throw new Error('No entries')
  return result.entries
}

function older(result: MessagesResult | 'not-found'): boolean {
  if (result === 'not-found' || result.state !== 'messages') throw new Error('No entries')
  return result.older
}

const textBytes = (list: MessageEntry[]) =>
  list.reduce(
    (sum, entry) => sum + (entry.kind === 'tool-calls' ? 0 : serializedTextBytes(entry.text)),
    0
  )

/** The projection always validates as a response the viewer accepts. */
function decodes(result: MessagesResult): boolean {
  return decodeMessages(
    JSON.stringify({
      v: PROTOCOL_VERSION,
      type: 'messages',
      session: 'AAAAAAAAAAAAAAAAAAAAAA',
      generation: 1,
      sentAt: 1,
      result
    })
  ).ok
}

describe('recent-messages budget', () => {
  it('keeps the newest 20 of 21 entries, oldest first, with older: true', () => {
    const all = Array.from({ length: 21 }, (_, index) => reply(`Reply ${index}`, index))
    const result = projectRecentMessages(read(all))
    const kept = entries(result)
    expect(kept).toHaveLength(20)
    expect(kept[0]).toEqual({ kind: 'reply', text: 'Reply 1', at: 1, cut: false })
    expect(kept.at(-1)).toMatchObject({ text: 'Reply 20' })
    expect(older(result)).toBe(true)
  })

  it("passes on the reader's hasOlder", () => {
    expect(older(projectRecentMessages(read([reply('A')], true)))).toBe(true)
    expect(older(projectRecentMessages(read([reply('A')], false)))).toBe(false)
  })

  it('drops the oldest entries when the texts total more than 65,536 bytes', () => {
    const result = projectRecentMessages(
      read([
        reply('a'.repeat(30_000), 1),
        reply('b'.repeat(30_000), 2),
        reply('c'.repeat(30_000), 3)
      ])
    )
    const kept = entries(result)
    expect(kept.map((entry) => entry.kind !== 'tool-calls' && entry.text[0])).toEqual(['b', 'c'])
    expect(kept.every((entry) => entry.kind === 'tool-calls' || !entry.cut)).toBe(true)
    expect(older(result)).toBe(true)
    expect(textBytes(kept)).toBeLessThanOrEqual(REMOTE_LIMITS.maxMessageTextBytes)
  })

  it('cuts one 70,000-byte reply to fit 65,536 serialized bytes', () => {
    const result = projectRecentMessages(read([reply('x'.repeat(70_000))]))
    const [entry] = entries(result)
    expect(entry).toMatchObject({ kind: 'reply', cut: true })
    expect(entry!.kind !== 'tool-calls' && serializedTextBytes(entry!.text)).toBe(65_536)
    // Nothing older was dropped; the cut is marked on the entry itself.
    expect(older(result)).toBe(false)
    expect(decodes(result as MessagesResult)).toBe(true)
  })

  it('cuts by serialized size when quotes and backslashes double on escaping', () => {
    const text = '"\\'.repeat(20_000)
    const [entry] = entries(projectRecentMessages(read([reply(text)])))
    if (entry?.kind !== 'reply') throw new Error('No reply')
    expect(entry.cut).toBe(true)
    expect(entry.text.length).toBeLessThan(text.length)
    expect(text.startsWith(entry.text)).toBe(true)
    expect(serializedTextBytes(entry.text)).toBeLessThanOrEqual(65_536)
    // Plain length would have allowed far more than this.
    expect(entry.text.length).toBeLessThanOrEqual(32_767)
  })

  it('never splits an astral character at the cut', () => {
    // 4 UTF-8 bytes each; 16,383 fit in 65,534 bytes with the quotes, the next one would not.
    const text = '😀'.repeat(20_000)
    const [entry] = entries(projectRecentMessages(read([reply(text)])))
    if (entry?.kind !== 'reply') throw new Error('No reply')
    expect(entry.cut).toBe(true)
    expect(Array.from(entry.text).every((point) => point === '😀')).toBe(true)
    expect(Array.from(entry.text)).toHaveLength(16_383)
    expect(new TextEncoder().encode(entry.text)).toHaveLength(16_383 * 4)
  })

  it('cuts only the newest text and drops older ones, keeping the list contiguous', () => {
    const result = projectRecentMessages(
      read([prompt('Synthetic prompt', 1), reply('y'.repeat(70_000), 2)])
    )
    const kept = entries(result)
    expect(kept).toHaveLength(1)
    expect(kept[0]).toMatchObject({ kind: 'reply', cut: true })
    expect(older(result)).toBe(true)
  })
})

describe('recent-messages content', () => {
  it('sends tool calls as a count and time only', () => {
    const calls: SessionMessage = {
      kind: 'tool-calls',
      count: 3,
      names: ['SENTINEL-TOOL-NAME'],
      at: 7,
      calls: [
        {
          name: 'SENTINEL-TOOL-NAME',
          at: 7,
          input: 'SENTINEL-TOOL-INPUT /Users/sentinel',
          inputLength: 30,
          nestedNames: ['SENTINEL-NESTED']
        }
      ]
    }
    const result = projectRecentMessages(read([prompt('Go'), calls]))
    expect(entries(result)[1]).toEqual({ kind: 'tool-calls', count: 3, at: 7 })
    expect(JSON.stringify(result)).not.toContain('SENTINEL')
  })

  it('caps the tool-call count and drops a run without calls', () => {
    const many: SessionMessage = { kind: 'tool-calls', count: 50_000, names: [], at: 1 }
    const none: SessionMessage = { kind: 'tool-calls', count: 0, names: [], at: 1 }
    const kept = entries(projectRecentMessages(read([prompt('Go'), many, none])))
    expect(kept).toEqual([
      { kind: 'prompt', text: 'Go', at: 1, cut: false },
      { kind: 'tool-calls', count: 10_000, at: 1 }
    ])
  })

  it('never sends the Codex error text', () => {
    const result = projectRecentMessages({
      kind: 'messages',
      messages: [reply('Done')],
      hasOlder: false,
      error: { cursor: 'SENTINEL-CURSOR', message: 'SENTINEL-ERROR-TEXT' }
    })
    expect(JSON.stringify(result)).not.toContain('SENTINEL')
  })

  it('maps the reader states', () => {
    expect(projectRecentMessages({ kind: 'not-found' })).toBe('not-found')
    expect(projectRecentMessages({ kind: 'unreadable' })).toEqual({
      state: 'unavailable',
      reason: 'unreadable'
    })
    expect(projectRecentMessages(read([]))).toEqual({ state: 'unavailable', reason: 'empty' })
    const onlyCalls: SessionMessage = { kind: 'tool-calls', count: 1, names: [], at: 1 }
    expect(projectRecentMessages(read([onlyCalls]))).toEqual({
      state: 'unavailable',
      reason: 'empty'
    })
  })

  it('rewrites skill-mention links to $name, also in code and quotes', () => {
    expect(
      cleanMessageText('Use [$demo-skill](/Users/sentinel/.agents/skills/demo/SKILL.md) now')
    ).toBe('Use $demo-skill now')
    expect(cleanMessageText('> [$a:b](</Users/sentinel/my skills/SKILL.md>)')).toBe('> $a:b')
    expect(cleanMessageText('`[$x](/Users/sentinel/SKILL.md)`')).toBe('`$x`')
    // Ordinary links and plain text stay as written; Markdown is untrusted on the viewer.
    expect(cleanMessageText('[docs](https://example.com) and $plain')).toBe(
      '[docs](https://example.com) and $plain'
    )
  })

  it('drops the path of every other form of link to a SKILL.md (TASK-034 F1)', () => {
    const cases: [string, string][] = [
      ['[$demo](/Users/sentinel/My Skills/demo/SKILL.md) now', '$demo now'],
      ['[$demo](/Users/sentinel/demo/skill.md)', '$demo'],
      ['[$demo](/Users/sentinel/demo/SKILL.md "title") x', '$demo x'],
      ['[$demo](/Users/sentinel/(x)/demo/SKILL.md).', '$demo.'],
      ['[$demo](/Users/sentinel/demo/SKILL.md#part)', '$demo'],
      ['[$demo]( /Users/sentinel/demo/SKILL.md )', '$demo'],
      ['[$demo] (/Users/sentinel/demo/SKILL.md)', '$demo'],
      ['[demo skill](/Users/sentinel/demo/SKILL.md)', 'demo skill'],
      ['[$demo](/Users/sentinel/demo/SKILL.md', '$demo'],
      ['[$a](/p/a/SKILL.md) and [$b](/p/b/SKILL.md)', '$a and $b']
    ]
    for (const [text, expected] of cases) expect(cleanMessageText(text), text).toBe(expected)
  })

  it('leaves links that do not lead to a SKILL.md, even with one later on the line', () => {
    for (const text of [
      '[docs](https://example.com/README.md) then SKILL.md',
      '[a](x) [b](y)\nSKILL.md',
      'Write a SKILL.md file',
      '[$x] is not a link (SKILL.md is a file name)'
    ]) {
      expect(cleanMessageText(text), text).toBe(text)
    }
  })

  it('stays fast on link starts crowded around SKILL.md', () => {
    const text = `${'[a]('.repeat(30_000)}SKILL.md ${'[b](x)y'.repeat(20_000)} SKILL.md`
    const started = performance.now()
    const cleaned = cleanMessageText(text)
    expect(performance.now() - started).toBeLessThan(1_000)
    expect(cleaned.length).toBeLessThan(text.length)
  })

  it('removes control and bidi characters but keeps tab and newline', () => {
    expect(cleanMessageText('a\u0000b\u0007c\u001b[31md\u007fe\u0085f')).toBe('abc[31mdef')
    expect(cleanMessageText('x‮y⁦z‏؜!')).toBe('xyz!')
    expect(cleanMessageText('one\ttwo\nthree\r\n')).toBe('one\ttwo\nthree\n')
    expect(cleanMessageText('lone \ud800 surrogate \udfff 😀')).toBe('lone  surrogate  😀')
  })

  it('drops an entry that cleaning leaves empty', () => {
    const kept = entries(projectRecentMessages(read([prompt('‮\u0000'), reply('Answer')])))
    expect(kept).toEqual([{ kind: 'reply', text: 'Answer', at: 1, cut: false }])
  })

  it('copies no field outside the allowlist', () => {
    const extra = { ...reply('Hi'), sentinel: 'SENTINEL-FIELD' } as unknown as SessionMessage
    const result = projectRecentMessages(read([extra]))
    expect(JSON.stringify(result)).not.toContain('SENTINEL')
    expect(decodes(result as MessagesResult)).toBe(true)
  })
})
