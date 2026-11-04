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
/**
 * `[$name](<path>/SKILL.md)` anywhere, also in code and quotes, so no skill path leaves the Mac.
 * The destination may be written in angle brackets.
 */
const SKILL_LINK =
  /\[\$([a-zA-Z0-9][a-zA-Z0-9:_-]{0,127})\]\((?:<[^<>\n]*\/SKILL\.md>|[^\s()<>]*\/SKILL\.md)\)/g

/** The Mac-side cleaning of protocol v2. Markdown is otherwise sent as written, and is untrusted. */
export function cleanMessageText(text: string): string {
  return text
    .replace(LONE_SURROGATES, '')
    .replace(CONTROLS, '')
    .replace(BIDI, '')
    .replace(SKILL_LINK, (_link, name: string) => `$${name}`)
}
