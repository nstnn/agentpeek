import type { RecentMessages, SessionMessage } from '../session'
import {
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
  const at = Number.isSafeInteger(message.at) && message.at >= 0 ? message.at : 0
  if (message.kind === 'tool-calls') {
    const count = Math.min(Math.floor(message.count), REMOTE_LIMITS.maxToolCallCount)
    return Number.isFinite(count) && count >= 1 ? [{ kind: 'tool-calls', count, at }] : []
  }
  const text = cleanMessageText(message.text)
  return text.length > 0 ? [{ kind: message.kind, text, at, cut: false }] : []
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
    if (size <= left) {
      kept.push(entry)
      left -= size
      continue
    }
    // The list stops here either way, so it stays contiguous: what is older is dropped.
    if (left === REMOTE_LIMITS.maxMessageTextBytes) {
      kept.push({ ...entry, text: cutToBytes(entry.text, left), cut: true })
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
/** `[label](` or `[label] (`: a label of up to 256 characters without brackets or line break. */
const LINK_START = /\[([^[\]\n]{1,256})\][ \t]*\(/g
/**
 * From just after the `(`: up to 1,024 characters on one line that reach `SKILL.md` in any case,
 * then whatever follows it up to the closing `)` (fragment, title, spaces, `>`). A `)` followed by
 * a space or the line end ends the link, so the search never runs into later text; any other `)`
 * may be part of the path.
 */
const SKILL_DESTINATION =
  /(?:[^\n)]|\)(?![ \t\n]|$)){0,1024}?skill\.md(?:[^\n)]{0,256}\)|(?=[ \t\n)]|$))/iy
const SKILL_FILE = /skill\.md/gi
/** Furthest a destination may reach before its `SKILL.md`. */
const SKILL_REACH = 1_024

/**
 * Every link to a `SKILL.md` becomes its label (`$name` for a skill mention), also in code and
 * quotes and in forms Markdown would not render as a link, so no skill path leaves the Mac. Stays
 * linear: a link start is tried only with a `SKILL.md` within reach, and a match consumes it.
 */
function stripSkillLinks(text: string): string {
  const files = Array.from(text.matchAll(SKILL_FILE), (match) => match.index)
  if (files.length === 0) return text
  let result = ''
  let copied = 0
  let next = 0
  LINK_START.lastIndex = 0
  for (let start = LINK_START.exec(text); start; start = LINK_START.exec(text)) {
    const from = LINK_START.lastIndex
    while (next < files.length && files[next]! < from) next += 1
    if (next === files.length) break
    if (files[next]! - from > SKILL_REACH) continue
    SKILL_DESTINATION.lastIndex = from
    if (!SKILL_DESTINATION.test(text)) continue
    result += text.slice(copied, start.index) + start[1]!
    copied = SKILL_DESTINATION.lastIndex
    LINK_START.lastIndex = copied
  }
  return result + text.slice(copied)
}

/** The Mac-side cleaning of protocol v2. Markdown is otherwise sent as written, and is untrusted. */
export function cleanMessageText(text: string): string {
  return stripSkillLinks(text.replace(LONE_SURROGATES, '').replace(CONTROLS, '').replace(BIDI, ''))
}
