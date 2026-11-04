import type { RecentMessages, SessionMessage } from '../session'
import {
  MAX_TIME,
  REMOTE_LIMITS,
  serializedTextBytes,
  type MessageEntry,
  type MessagesResult
} from './protocol'

// The Remote View recent-messages projection (TASK-032, protocol v2): turns what the existing
// bounded reader returned for one session into the only shape that may leave the Mac. Like the
// status projection, every field is copied from an allowlist: tool names, tool input and output,
// Codex error text, read cursors and anything added to `RecentMessages` later stay on the Mac.
// Pure, so the listener and the tests apply the same budget.

/** The reader is asked for this many entries; it reports whether older ones exist. */
export const REMOTE_MESSAGES_READ_LIMIT = REMOTE_LIMITS.maxEntries

/** `not-found` is answered as the protocol error of that name, never as a result. */
export function projectRecentMessages(read: RecentMessages): MessagesResult | 'not-found' {
  if (read.kind === 'not-found') return 'not-found'
  if (read.kind === 'unreadable') return { state: 'unavailable', reason: 'unreadable' }
  const entries = read.messages.flatMap(projectEntry)
  if (!entries.some((entry) => entry.kind !== 'tool-calls')) {
    return { state: 'unavailable', reason: 'empty' }
  }
  return budget(entries, read.hasOlder)
}

function projectEntry(message: SessionMessage): MessageEntry[] {
  const at =
    Number.isSafeInteger(message.at) && message.at >= 0 && message.at <= MAX_TIME ? message.at : 0
  if (message.kind === 'tool-calls') {
    const count = Math.min(Math.floor(message.count), REMOTE_LIMITS.maxToolCallCount)
    return Number.isFinite(count) && count >= 1 ? [{ kind: 'tool-calls', count, at }] : []
  }
  // Text beyond what the budget could ever send is not cleaned or kept: cleaning stays cheap even
  // for a multi-megabyte reply, and the entry is marked cut.
  const long = message.text.length > RAW_TEXT_LIMIT
  const text = long
    ? cleanMessageText(dropUnfinishedTail(cutRaw(message.text)))
    : cleanMessageText(message.text)
  if (text.length === 0) return []
  const entry: MessageEntry = { kind: message.kind, text, at, cut: false }
  if (long) cutBeforeCleaning.add(entry)
  return [entry]
}

/** More characters than the text budget has bytes, plus room for what the tail drop removes. */
const RAW_TEXT_LIMIT = 65_536 + 32_768
/** How far back from a cut the tail drop looks for the start of a split link. */
const UNFINISHED_REACH = 16_384

/** Entries whose text was cut before cleaning; only the newest text may be sent cut. */
const cutBeforeCleaning = new WeakSet<MessageEntry>()

/**
 * A cut can end inside a link, whose target then has no end. Before cleaning, everything from the
 * first `[`, `]`, `<` or `=` of the last paragraph (at most 16,384 characters back) is dropped:
 * the entry is sent cut anyway. A target longer than that can still be sent in part.
 */
function dropUnfinishedTail(text: string): string {
  const blank = text.lastIndexOf('\n\n')
  const from = Math.max(blank === -1 ? 0 : blank, text.length - UNFINISHED_REACH)
  const at = text.slice(from).search(/[[\]<=]/)
  return at === -1 ? text : text.slice(0, from + at)
}

function cutRaw(text: string): string {
  const end = /[\ud800-\udbff]/.test(text[RAW_TEXT_LIMIT - 1]!)
    ? RAW_TEXT_LIMIT - 1
    : RAW_TEXT_LIMIT
  return text.slice(0, end)
}

/**
 * Keeps the newest entries within both budgets, oldest first. Older entries go first; only an
 * entry that does not fit while no text is kept yet (the newest text) is cut instead.
 */
function budget(all: MessageEntry[], hasOlder: boolean): MessagesResult {
  const recent = all.slice(-REMOTE_LIMITS.maxEntries)
  let older = hasOlder || recent.length < all.length
  const kept: MessageEntry[] = []
  let left = REMOTE_LIMITS.maxMessageTextBytes
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const entry = recent[index]!
    if (entry.kind === 'tool-calls') {
      kept.push(entry)
      continue
    }
    const size = serializedTextBytes(entry.text)
    const precut = cutBeforeCleaning.has(entry)
    if (size <= left && !precut) {
      kept.push(entry)
      left -= size
      continue
    }
    // The list stops here either way, so it stays contiguous: what is older is dropped.
    if (left === REMOTE_LIMITS.maxMessageTextBytes) {
      const text = size <= left ? entry.text : cutToBytes(entry.text, left)
      kept.push({ ...entry, text, cut: true })
      older = older || index > 0
    } else {
      older = true
    }
    break
  }
  return { state: 'messages', entries: kept.reverse(), older }
}

/** The longest prefix, in whole code points, whose serialized string fits `maxBytes`. */
function cutToBytes(text: string, maxBytes: number): string {
  const points = Array.from(text)
  let low = 0
  let high = points.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (serializedTextBytes(points.slice(0, mid).join('')) <= maxBytes) low = mid
    else high = mid - 1
  }
  return points.slice(0, low).join('')
}

/** C0/C1 controls except tab and newline. */
const CONTROLS = /(?![\t\n])\p{Cc}/gu
/** Bidi marks, embeddings, overrides and isolates. */
const BIDI = /[؜‎‏‪-‮⁦-⁩]/g
/** Lone surrogates cannot be serialized as UTF-8 and are never part of real text. */
const LONE_SURROGATES = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g

/**
 * The Mac-side cleaning of protocol v2: control, bidi and lone surrogate characters are removed,
 * then link targets (see `stripLinkTargets`). Markdown is otherwise sent as written, and is
 * untrusted.
 */
export function cleanMessageText(text: string): string {
  return stripLinkTargets(text.replace(LONE_SURROGATES, '').replace(CONTROLS, '').replace(BIDI, ''))
}

/**
 * Furthest a destination is checked for a `SKILL.md` from its `(`, or may reach without a matching
 * `)`. A link with a matching `)` has no limit outside code.
 */
const DESTINATION_REACH = 2_048
/** Characters checked for a `SKILL.md` per text; past it, a link-shaped construct is stripped. */
const SKILL_CHECK_BUDGET = 262_144
/** `href=`, `src=`, `srcset=` or `xlink:href=` and its value, at a word start. */
const ATTRIBUTE = /(?:href|src|srcset|xlink:href)[ \t]*=[ \t]*("[^"\n]*"|'[^'\n]*'|[^\s"'<>`=]+)/iy
const ZERO_WIDTH = /[\\\u00ad\u200b-\u200d\u2060\ufeff]/g

interface Edit {
  from: number
  to: number
  insert: string
}

/**
 * Link targets never leave the Mac; the viewer shows links as their text anyway (REQ-010 S2).
 *
 * Code is not told apart from prose, so a misread code block can never keep a target (the owner
 * chose this over showing code like `fns[key](arg)` exactly, 2026-11-04):
 *
 * - `[label](target)` becomes `label`, `![alt](target)` becomes `![alt]()`, a reference definition
 *   `[x]: target` (also in a list item) becomes `[x]: <>`, and an HTML `href`, `src`, `srcset` or
 *   `xlink:href` value becomes `""`.
 * - Also in forms Markdown would not render as a link (`[label] (…)`, a missing `)`, a definition
 *   inside a line): a link, definition or autolink to a `SKILL.md`, also case-changed, percent- or
 *   entity-encoded, escaped or split by a zero-width character, is replaced the same way, so a
 *   skill mention `[$name](…/SKILL.md)` becomes `$name`.
 *
 * A path typed in the text itself is sent as written. Linear: parentheses are matched in one pass,
 * every step moves forward, and the `SKILL.md` checks share one bounded budget.
 */
function stripLinkTargets(text: string): string {
  if (!/[[<=]/.test(text)) return text
  const edits: Edit[] = []
  const close = new Int32Array(text.length).fill(-1)
  // The next newline and the next `)` at or after each index, so no lookup scans ahead.
  const nextNewline = new Int32Array(text.length + 1)
  const nextClose = new Int32Array(text.length + 1)
  nextNewline[text.length] = text.length
  nextClose[text.length] = -1
  for (let index = text.length - 1; index >= 0; index -= 1) {
    nextNewline[index] = text[index] === '\n' ? index : nextNewline[index + 1]!
    nextClose[index] = text[index] === ')' ? index : nextClose[index + 1]!
  }
  const skillFiles = Array.from(text.matchAll(/skill\.md/gi), (match) => match.index)
  let budget = SKILL_CHECK_BUDGET

  function isSkill(value: string): boolean {
    budget -= value.length
    if (budget < 0) return true
    return /skill\.md/.test(
      value
        .toLowerCase()
        .replace(ZERO_WIDTH, '')
        .replace(/%([0-9a-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
        .replace(/&#(x[0-9a-f]{1,6}|\d{1,7});?/g, (_, code: string) =>
          String.fromCodePoint(
            Math.min(code[0] === 'x' ? parseInt(code.slice(1), 16) : Number(code), 0x10ffff)
          )
        )
        .replace(/&period;?/g, '.')
    )
  }

  /** Whether a `SKILL.md` (as written) lies in [from, to). */
  function skillWithin(from: number, to: number): boolean {
    let low = 0
    let high = skillFiles.length
    while (low < high) {
      const mid = (low + high) >> 1
      if (skillFiles[mid]! < from) low = mid + 1
      else high = mid
    }
    return low < skillFiles.length && skillFiles[low]! < to
  }

  function lineEnd(from: number, end: number): number {
    return Math.min(nextNewline[Math.min(from, text.length)]!, end)
  }

  /** Whether the line starting at `from` holds only spaces and tabs. */
  function blankLine(from: number, end: number): boolean {
    for (let index = from; index < end; index += 1) {
      const char = text[index]
      if (char === '\n') return true
      if (char !== ' ' && char !== '\t') return false
    }
    return true
  }

  /** Only indent, quote and list markers stand before `at` on its line. */
  function atLineStart(at: number): boolean {
    for (let index = at - 1; index >= Math.max(0, at - 64); index -= 1) {
      const char = text[index]!
      if (char === '\n') return true
      if (!/[ \t>*+\-.)0-9]/.test(char)) return false
    }
    return at <= 64
  }

  /** Each `(` in [start, end) gets the index of its `)`, paragraph by paragraph. */
  function matchParentheses(start: number, end: number): void {
    const open: number[] = []
    for (let index = start; index < end; index += 1) {
      const char = text[index]
      if (char === '\\') index += 1
      else if (char === '(') open.push(index)
      else if (char === ')') {
        const from = open.pop()
        if (from !== undefined) close[from] = index
      } else if (char === '\n' && blankLine(index + 1, end)) open.length = 0
    }
  }

  function strip(start: number, end: number): void {
    matchParentheses(start, end)
    const brackets: { at: number; image: boolean }[] = []
    let index = start
    while (index < end) {
      const char = text[index]!
      if (char === '\\') {
        index += 2
        continue
      }
      if (char === '\n') {
        if (blankLine(index + 1, end)) brackets.length = 0
        index += 1
        continue
      }
      if (char === '<') {
        let to = index + 1
        while (to < end && to - index <= DESTINATION_REACH && !/[\s<>]/.test(text[to]!)) to += 1
        if (text[to] === '>' && to > index + 1 && isSkill(text.slice(index + 1, to))) {
          edits.push({ from: index, to: to + 1, insert: '' })
          index = to + 1
          continue
        }
        index += 1
        continue
      }
      if ('hHsSxX'.includes(char)) {
        if (index > start && /[\s"']/.test(text[index - 1]!)) {
          ATTRIBUTE.lastIndex = index
          const attribute = ATTRIBUTE.exec(text)
          if (attribute && ATTRIBUTE.lastIndex <= end) {
            const valueAt = ATTRIBUTE.lastIndex - attribute[1]!.length
            edits.push({ from: valueAt, to: ATTRIBUTE.lastIndex, insert: '""' })
            index = ATTRIBUTE.lastIndex
            continue
          }
        }
        index += 1
        continue
      }
      if (char === '[') {
        brackets.push({ at: index, image: index > 0 && text[index - 1] === '!' })
        index += 1
        continue
      }
      if (char !== ']') {
        index += 1
        continue
      }
      const open = brackets.pop()
      if (open === undefined) {
        index += 1
        continue
      }
      if (text[index + 1] === ':' && text[open.at + 1] !== '^') {
        // A definition inside a line is not one to Markdown; only a `SKILL.md` target is dropped.
        const stop = lineEnd(index + 2, end)
        if (
          atLineStart(open.at) ||
          isSkill(text.slice(index + 2, Math.min(stop, index + 2 + DESTINATION_REACH)))
        ) {
          index = stripDefinition(index + 2, end)
          continue
        }
      }
      let paren = index + 1
      while (paren < end && (text[paren] === ' ' || text[paren] === '\t')) paren += 1
      if (text[paren] !== '(') {
        index += 1
        continue
      }
      const strict = paren === index + 1
      const to = close[paren]!
      if (to !== -1 && to < end && (strict || to - paren <= DESTINATION_REACH)) {
        if (strict || isSkill(text.slice(paren + 1, to))) {
          replaceLink(open, index, to + 1)
          index = to + 1
          continue
        }
      } else {
        const stop = lineEnd(paren, end)
        // An unbalanced `(` in a title or path: the first `)` on the line ends the link.
        const first = nextClose[paren]!
        if (strict && first !== -1 && first < stop && first - paren <= DESTINATION_REACH) {
          replaceLink(open, index, first + 1)
          index = first + 1
          continue
        }
        // No `)`: Markdown shows this as text, but a skill path in it is still dropped.
        if (skillWithin(paren, stop)) {
          replaceLink(open, index, stop)
          index = stop
          continue
        }
      }
      index += 1
    }
  }

  /** `[label](…)` becomes `label`; `![alt](…)` becomes `![alt]()`. */
  function replaceLink(open: { at: number; image: boolean }, bracket: number, to: number): void {
    if (open.image) {
      edits.push({ from: bracket + 1, to, insert: '()' })
    } else {
      edits.push({ from: open.at, to: open.at + 1, insert: '' })
      edits.push({ from: bracket, to, insert: '' })
    }
  }

  /** From just after `]:`, the target (on this line or the next) becomes `<>`. */
  function stripDefinition(from: number, end: number): number {
    const stop = lineEnd(from, end)
    if (text.slice(from, stop).trim().length > 0) {
      edits.push({ from, to: stop, insert: ' <>' })
      return stop
    }
    if (stop >= end || blankLine(stop + 1, end)) return stop
    const nextStop = lineEnd(stop + 1, end)
    edits.push({ from: stop + 1, to: nextStop, insert: '<>' })
    return nextStop
  }

  strip(0, text.length)

  if (edits.length === 0) return text
  edits.sort((a, b) => a.from - b.from)
  let result = ''
  let copied = 0
  for (const edit of edits) {
    if (edit.from < copied) continue
    result += text.slice(copied, edit.from) + edit.insert
    copied = edit.to
  }
  return result + text.slice(copied)
}
