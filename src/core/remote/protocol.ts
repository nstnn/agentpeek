import { isRemoteTool, REMOTE_TOOLS, type RemoteTool } from './share-policy'
import {
  REMOTE_STATUS_LIMITS,
  type RemoteProject,
  type RemoteSession,
  type RemoteStatus
} from './status-projection'

// Remote View protocol v2 (TASK-003, extended by TASK-031/032): the routes, request checks, frames
// and limits of the loopback listener that the owner's `tailscale serve` publishes. Both sides use
// this module: the listener (TASK-014) checks requests and encodes frames, the viewer (TASK-017/018)
// decodes and validates them. It is pure and browser-safe. The prose contracts, with the request
// trace, are in the local plan (`plan/remote-view/design/protocol-v1.md` and
// `recent-messages-contract.md`). v2 is v1 plus the status `details` field and the recent-messages
// route; the page and the listener ship together, so v1 is simply an unsupported version.

export const PROTOCOL_VERSION = 2

export const REMOTE_ROUTES = {
  /** The viewer page. */
  page: '/',
  /** The one Server-Sent Events stream of status frames. */
  status: `/v${PROTOCOL_VERSION}/status`,
  /** One session's recent messages, by the opaque ID from the status. */
  messages: (session: string) => `/v${PROTOCOL_VERSION}/sessions/${session}/messages`
} as const

/** The port the settings propose (TASK-002); the owner may pick another from 1024 to 65535. */
export const REMOTE_DEFAULT_PORT = 47613

/** Hashed build assets (TASK-005), the only other paths the listener serves. */
const ASSET_PATH = /^\/assets\/[A-Za-z0-9_-]{1,64}\.(?:js|css)$/
const MESSAGES_PATH = new RegExp(`^/v${PROTOCOL_VERSION}/sessions/([A-Za-z0-9_-]{22})/messages$`)
/** Any version of a known route; another version than this one is `unsupported-version`. */
const VERSIONED_PATH = /^\/v(\d{1,6})\/(?:status|sessions\/[^/?#]*\/messages)$/

/** Frozen limits. Each one is checked by a test vector or by the card that enforces it. */
export const REMOTE_LIMITS = {
  /** Open status streams; one more is answered `busy`. */
  maxStreams: 5,
  /** Serialized `data` of one frame, in UTF-8 bytes. A status that would exceed it drops rows. */
  maxFrameBytes: 192 * 1024,
  /** Bytes queued on one stream before it is ended with `slow-consumer`. */
  maxBufferedBytesPerStream: 512 * 1024,
  /** At most two status frames a second per stream. */
  minStatusIntervalMs: 500,
  /** A heartbeat frame every 15 s, also when nothing changed. */
  heartbeatIntervalMs: 15_000,
  /** The viewer treats the stream as lost after this long without any frame. */
  silenceLimitMs: 45_000,
  /** Reconnect delay: full jitter on base * 2^attempt, capped. */
  reconnectBaseMs: 1_000,
  reconnectMaxMs: 30_000,
  /** Token bucket over all requests; every client arrives from loopback through Serve. */
  requestsPerSecond: 10,
  requestBurst: 20,
  /** `Retry-After` seconds for `busy` and `rate-limited`. */
  retryAfterSeconds: 5,
  maxRequestTargetLength: 2048,
  maxSnapshotIdLength: 64,
  /** Recent-message requests in progress over all clients; one more is answered `busy`. */
  maxDetailRequests: 2,
  /** Entries in one recent-messages response, oldest first. */
  maxEntries: 20,
  /** All entry texts together, each measured as a serialized JSON string in UTF-8 bytes. */
  maxMessageTextBytes: 65_536,
  /** One serialized recent-messages response; the viewer treats more as `oversize`. */
  maxDetailBytes: 72 * 1024,
  /** The largest tool-call count one entry reports. */
  maxToolCallCount: 10_000,
  /** While a detail is open, at most one new request this often when the session changes. */
  detailRefreshMs: 2_000
} as const

/** Typed errors. The body never carries session data or echoes a request value. */
export const REMOTE_ERROR_STATUS = {
  'rate-limited': 429,
  'not-allowed': 403,
  'bad-host': 421,
  'bad-origin': 403,
  'method-not-allowed': 405,
  'bad-request': 400,
  'not-found': 404,
  'unsupported-version': 404,
  busy: 503,
  /** "Share recent messages" is off. */
  'details-off': 403,
  /** The sharing policy changed while the messages were read; nothing was sent. */
  'policy-changed': 409
} as const

export type RemoteErrorCode = keyof typeof REMOTE_ERROR_STATUS

/** The JSON body of every error response. */
export interface RemoteErrorBody {
  v: typeof PROTOCOL_VERSION
  error: RemoteErrorCode
}

export type RemoteRoute =
  | { route: 'page' }
  | { route: 'status' }
  | { route: 'asset'; path: string }
  /** `session` is the opaque ID as requested; the listener resolves it, or answers `not-found`. */
  | { route: 'messages'; session: string }

/** What the listener is configured with. Both values are trimmed when settings are saved. */
export interface RemoteAccessConfig {
  /** The owner's Tailscale login, compared exactly with `Tailscale-User-Login`. */
  ownerLogin: string
  /** The Mac's `<device>.<tailnet>.ts.net` name, without scheme or port. */
  hostName: string
}

/** A request as Node reports it: lowercase header names, repeated headers as arrays. */
export interface RemoteRequest {
  method: string | undefined
  target: string | undefined
  headers: Readonly<Record<string, string | readonly string[] | undefined>>
}

export type RemoteRequestDecision =
  { ok: true; route: RemoteRoute } | { ok: false; error: RemoteErrorCode }

/**
 * Checks one request in the frozen order, after the listener's rate limit and before its stream
 * cap: login, Host, Origin, method, body, target. The first failure decides the error, so a client
 * without the owner's login learns nothing about the other checks.
 *
 * A missing login header covers every client that Serve does not vouch for: direct loopback
 * connections, tagged devices and Funnel traffic. It is not proof against processes on the Mac,
 * which can connect to loopback and send any header; they could already read the tool files.
 */
export function checkRemoteRequest(
  request: RemoteRequest,
  config: RemoteAccessConfig
): RemoteRequestDecision {
  const login = single(request.headers['tailscale-user-login'])
  if (
    login === null ||
    config.ownerLogin === '' ||
    login.includes(',') ||
    login.trim() !== config.ownerLogin
  ) {
    return { ok: false, error: 'not-allowed' }
  }

  const host = single(request.headers.host)
  if (host === null || !isTailnetHostName(config.hostName) || !sameName(host, config.hostName)) {
    return { ok: false, error: 'bad-host' }
  }

  const origin = request.headers.origin
  if (origin !== undefined) {
    const value = single(origin)
    if (value === null || !sameName(value, `https://${config.hostName}`)) {
      return { ok: false, error: 'bad-origin' }
    }
  }

  if (request.method !== 'GET') return { ok: false, error: 'method-not-allowed' }

  const length = request.headers['content-length']
  if (
    request.headers['transfer-encoding'] !== undefined ||
    (length !== undefined && length !== '0')
  ) {
    return { ok: false, error: 'bad-request' }
  }

  const target = request.target
  if (
    target === undefined ||
    !target.startsWith('/') ||
    target.length > REMOTE_LIMITS.maxRequestTargetLength
  ) {
    return { ok: false, error: 'bad-request' }
  }
  if (target === REMOTE_ROUTES.page) return { ok: true, route: { route: 'page' } }
  if (target === REMOTE_ROUTES.status) return { ok: true, route: { route: 'status' } }
  if (ASSET_PATH.test(target)) return { ok: true, route: { route: 'asset', path: target } }
  const messages = MESSAGES_PATH.exec(target)
  if (messages) return { ok: true, route: { route: 'messages', session: messages[1]! } }
  const versioned = VERSIONED_PATH.exec(target)
  if (versioned && Number(versioned[1]) !== PROTOCOL_VERSION) {
    return { ok: false, error: 'unsupported-version' }
  }
  // Query strings and fragments are not part of any route.
  return { ok: false, error: 'not-found' }
}

/** `<device>.<tailnet>.ts.net` in lowercase DNS labels, as Tailscale HTTPS names a machine. */
export function isTailnetHostName(name: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ts\.net$/.test(
    name
  )
}

export function errorBody(error: RemoteErrorCode): string {
  const body: RemoteErrorBody = { v: PROTOCOL_VERSION, error }
  return JSON.stringify(body)
}

// Frames. Each is one Server-Sent Event, `event: <type>` and one `data:` line of JSON, without
// `id:` (a reconnect always starts over with a full status) and without `retry:` (the viewer reads
// the stream with fetch and owns its backoff, so it can see the typed HTTP errors).

/** A complete replacement of everything the viewer shows. */
export interface StatusFrame {
  v: typeof PROTOCOL_VERSION
  type: 'status'
  /** Changes whenever the status or generation changes; an identical resend keeps it. */
  snapshotId: string
  /** The sharing-policy generation. Within one stream it never decreases. */
  generation: number
  /** When the Mac made the desktop snapshot. Resending never changes it. */
  observedAt: number
  /** The Mac clock when the frame was written. */
  sentAt: number
  /** True only while Remote View and "Share recent messages" are both on. */
  details: boolean
  status: RemoteStatus
}

/** Proves the stream and the Mac are alive when nothing changed. */
export interface HeartbeatFrame {
  v: typeof PROTOCOL_VERSION
  type: 'heartbeat'
  snapshotId: string
  generation: number
  sentAt: number
}

/**
 * Why the Mac ended a stream:
 * - `remote-off`: the owner turned Remote View off; the listener is gone.
 * - `access-changed`: the allowed login or host name changed; a reconnect is checked again.
 * - `shutdown`: AgentPeek is quitting.
 * - `slow-consumer`: the stream fell more than the buffer budget behind.
 */
export type EndReason = 'remote-off' | 'access-changed' | 'shutdown' | 'slow-consumer'

export interface EndFrame {
  v: typeof PROTOCOL_VERSION
  type: 'end'
  reason: EndReason
}

export type RemoteFrame = StatusFrame | HeartbeatFrame | EndFrame

export type EncodeResult =
  { ok: true; event: string; frame: RemoteFrame } | { ok: false; error: 'oversize' }

/**
 * Writes one frame as a Server-Sent Event. A status frame that exceeds the byte budget keeps its
 * newest rows and counts the rest in `omitted.sessions`; only a frame that cannot fit even without
 * rows fails.
 */
export function encodeFrame(frame: RemoteFrame): EncodeResult {
  if (frame.type !== 'status') return { ok: true, event: sse(frame), frame }
  const all = rowsByRecency(frame.status)
  const fit = (count: number): StatusFrame => ({
    ...frame,
    status: keepRows(frame.status, all, count)
  })
  if (byteLength(JSON.stringify(fit(all.length))) <= REMOTE_LIMITS.maxFrameBytes) {
    return { ok: true, event: sse(frame), frame }
  }
  // The largest row count that fits; rows only add bytes, so the search is monotonic.
  let low = 0
  let high = all.length - 1
  if (byteLength(JSON.stringify(fit(0))) > REMOTE_LIMITS.maxFrameBytes) {
    return { ok: false, error: 'oversize' }
  }
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (byteLength(JSON.stringify(fit(mid))) <= REMOTE_LIMITS.maxFrameBytes) low = mid
    else high = mid - 1
  }
  const kept = fit(low)
  return { ok: true, event: sse(kept), frame: kept }
}

function sse(frame: RemoteFrame): string {
  return `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`
}

function rowsByRecency(status: RemoteStatus): RemoteSession[] {
  return status.projects
    .flatMap((project) => project.sessions)
    .sort((a, b) =>
      a.lastActivityAt !== b.lastActivityAt
        ? b.lastActivityAt - a.lastActivityAt
        : a.id < b.id
          ? -1
          : a.id > b.id
            ? 1
            : 0
    )
}

function keepRows(status: RemoteStatus, ordered: RemoteSession[], count: number): RemoteStatus {
  const kept = new Set(ordered.slice(0, count))
  const projects: RemoteProject[] = status.projects.map((project) => ({
    label: project.label,
    sessions: project.sessions.filter((session) => kept.has(session))
  }))
  return {
    ...status,
    projects,
    omitted: {
      projects: status.omitted.projects,
      sessions: status.omitted.sessions + ordered.length - kept.size
    }
  }
}

export type DecodeError = 'malformed' | 'oversize' | 'unsupported-version'

export type DecodeResult = { ok: true; frame: RemoteFrame } | { ok: false; error: DecodeError }

/**
 * Reads one event in the viewer. `unsupported-version` means the page is older or newer than the
 * Mac: stop retrying and ask for a reload. `malformed` and `oversize` drop the connection and
 * reconnect with backoff. Unknown fields are malformed, so nothing outside the allowlist is shown.
 */
export function decodeFrame(event: string, data: string): DecodeResult {
  if (byteLength(data) > REMOTE_LIMITS.maxFrameBytes) return { ok: false, error: 'oversize' }
  let value: unknown
  try {
    value = JSON.parse(data)
  } catch {
    return { ok: false, error: 'malformed' }
  }
  if (!isRecord(value)) return { ok: false, error: 'malformed' }
  if (value.v !== PROTOCOL_VERSION) {
    return typeof value.v === 'number'
      ? { ok: false, error: 'unsupported-version' }
      : { ok: false, error: 'malformed' }
  }
  if (value.type !== event) return { ok: false, error: 'malformed' }
  const valid =
    event === 'status'
      ? isStatusFrame(value)
      : event === 'heartbeat'
        ? isHeartbeatFrame(value)
        : event === 'end' && isEndFrame(value)
  return valid
    ? { ok: true, frame: value as unknown as RemoteFrame }
    : { ok: false, error: 'malformed' }
}

/** The viewer's wait before reconnect attempt `attempt` (0-based), with full jitter. */
export function reconnectDelayMs(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(
    REMOTE_LIMITS.reconnectMaxMs,
    REMOTE_LIMITS.reconnectBaseMs * 2 ** Math.min(Math.max(attempt, 0), 16)
  )
  return Math.floor(random() * ceiling)
}

/**
 * The Mac's clock now, estimated from the last frame: its `sentAt` plus the local time elapsed
 * since it arrived. The viewer computes "2 min ago" from this, never from its own wall clock, so a
 * phone whose clock is off still shows the Mac's times correctly.
 */
export function macNow(lastSentAt: number, receivedAtLocal: number, nowLocal: number): number {
  return lastSentAt + Math.max(0, nowLocal - receivedAtLocal)
}

// Validation. Exact key sets, enums and ranges; no field is trusted because it parsed.

type Json = Record<string, unknown>

const HEALTH_STATES = ['off', 'checking', 'not-installed', 'unsupported'] as const
const UNKNOWN_REASONS = ['process-ended', 'app-not-running', 'quiet', 'unreadable', 'unsupported']
const WAITING_KINDS = ['permission', 'question', 'dialog', 'sandbox', 'worker', 'goal', 'other']
const END_REASONS: readonly EndReason[] = [
  'remote-off',
  'access-changed',
  'shutdown',
  'slow-consumer'
]
const SESSION_ID = /^[A-Za-z0-9_-]{22}$/
const SNAPSHOT_ID = new RegExp(`^[A-Za-z0-9_-]{1,${REMOTE_LIMITS.maxSnapshotIdLength}}$`)

function isStatusFrame(value: Json): boolean {
  return (
    hasKeys(value, [
      'v',
      'type',
      'snapshotId',
      'generation',
      'observedAt',
      'sentAt',
      'details',
      'status'
    ]) &&
    isSnapshotId(value.snapshotId) &&
    isCount(value.generation) &&
    isTime(value.observedAt) &&
    isTime(value.sentAt) &&
    typeof value.details === 'boolean' &&
    isStatus(value.status)
  )
}

function isHeartbeatFrame(value: Json): boolean {
  return (
    hasKeys(value, ['v', 'type', 'snapshotId', 'generation', 'sentAt']) &&
    isSnapshotId(value.snapshotId) &&
    isCount(value.generation) &&
    isTime(value.sentAt)
  )
}

function isEndFrame(value: Json): boolean {
  return hasKeys(value, ['v', 'type', 'reason']) && END_REASONS.includes(value.reason as EndReason)
}

function isStatus(value: unknown): boolean {
  if (!isRecord(value) || !hasKeys(value, ['observedAt', 'sources', 'projects', 'omitted'])) {
    return false
  }
  if (!isTime(value.observedAt) || !isSources(value.sources)) return false
  const { omitted, projects } = value
  if (!isRecord(omitted) || !hasKeys(omitted, ['projects', 'sessions'])) return false
  if (!isCount(omitted.projects) || !isCount(omitted.sessions)) return false
  if (!Array.isArray(projects) || projects.length > REMOTE_STATUS_LIMITS.maxProjects) return false
  let rows = 0
  for (const project of projects as unknown[]) {
    if (!isRecord(project) || !hasKeys(project, ['label', 'sessions'])) return false
    if (!isText(project.label) || !Array.isArray(project.sessions)) return false
    rows += project.sessions.length
    if (rows > REMOTE_STATUS_LIMITS.maxSessions) return false
    if (!(project.sessions as unknown[]).every(isSession)) return false
  }
  return true
}

function isSources(value: unknown): boolean {
  if (!isRecord(value) || !hasKeys(value, REMOTE_TOOLS)) return false
  return REMOTE_TOOLS.every((tool: RemoteTool) => {
    const health = value[tool]
    if (!isRecord(health)) return false
    if ((HEALTH_STATES as readonly unknown[]).includes(health.state))
      return hasKeys(health, ['state'])
    if (health.state === 'connected') {
      return hasKeys(health, ['state', 'lastReadAt']) && isTime(health.lastReadAt)
    }
    return (
      health.state === 'no-access' &&
      hasKeys(health, ['state', 'lastReadAt']) &&
      (health.lastReadAt === null || isTime(health.lastReadAt))
    )
  })
}

function isSession(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasKeys(value, [
      'id',
      'tool',
      'title',
      'activity',
      'attention',
      'attentionSince',
      'lastActivityAt'
    ])
  ) {
    return false
  }
  const { activity, attention } = value
  return (
    typeof value.id === 'string' &&
    SESSION_ID.test(value.id) &&
    isRemoteTool(value.tool) &&
    isText(value.title) &&
    isActivity(activity) &&
    isRecord(attention) &&
    hasKeys(attention, ['waiting', 'newReply', 'error']) &&
    Object.values(attention).every((flag) => typeof flag === 'boolean') &&
    (value.attentionSince === null || isTime(value.attentionSince)) &&
    isTime(value.lastActivityAt)
  )
}

function isActivity(value: unknown): boolean {
  if (!isRecord(value)) return false
  switch (value.state) {
    case 'running':
    case 'idle':
      return hasKeys(value, ['state'])
    case 'waiting':
      return hasKeys(value, ['state', 'kind']) && WAITING_KINDS.includes(value.kind as string)
    case 'unknown':
      return hasKeys(value, ['state', 'reason']) && UNKNOWN_REASONS.includes(value.reason as string)
    default:
      return false
  }
}

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Exactly these keys, no more and no fewer. */
function hasKeys(value: Json, keys: readonly string[]): boolean {
  const own = Object.keys(value)
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

/** The latest time a JavaScript `Date` can hold; a later one cannot be shown. */
export const MAX_TIME = 8_640_000_000_000_000

function isTime(value: unknown): boolean {
  return isCount(value) && (value as number) <= MAX_TIME
}

function isCount(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function isSnapshotId(value: unknown): boolean {
  return typeof value === 'string' && SNAPSHOT_ID.test(value)
}

/** Non-empty text within the projection's code-point budget. */
function isText(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0) return false
  return Array.from(value).length <= REMOTE_STATUS_LIMITS.maxTextLength
}

function single(value: string | readonly string[] | undefined): string | null {
  return typeof value === 'string' ? value : null
}

/** Host names compare without case, as DNS does; nothing else is normalized. */
function sameName(value: string, expected: string): boolean {
  return value.toLowerCase() === expected.toLowerCase()
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

// Recent messages (protocol v2, TASK-032). One JSON response per request, never a stream frame.
// The Mac builds the result with `projectRecentMessages` (`recent-messages.ts`); the viewer reads
// it with `decodeMessages` and keeps it only if `bindMessages` accepts it.

/** A prompt or reply, or a run of tool calls as a count only: no names, input or output. */
export type MessageEntry =
  | { kind: 'prompt' | 'reply'; text: string; at: number; cut: boolean }
  | { kind: 'tool-calls'; count: number; at: number }

export type MessagesResult =
  | { state: 'messages'; entries: MessageEntry[]; older: boolean }
  | { state: 'unavailable'; reason: 'unreadable' | 'unsupported' | 'empty' }

export interface MessagesResponse {
  v: typeof PROTOCOL_VERSION
  type: 'messages'
  /** The opaque ID the request named. */
  session: string
  /** The sharing-policy generation the response was checked under, just before it was written. */
  generation: number
  sentAt: number
  result: MessagesResult
}

export type MessagesDecodeResult =
  { ok: true; response: MessagesResponse } | { ok: false; error: DecodeError }

/** UTF-8 bytes of `text` written as a JSON string, quotes and escapes included. */
export function serializedTextBytes(text: string): number {
  return byteLength(JSON.stringify(text))
}

/**
 * Reads one recent-messages response in the viewer, with the same rules as status frames: exact
 * keys and enums, and any budget exceeded is `oversize`.
 */
export function decodeMessages(data: string): MessagesDecodeResult {
  if (byteLength(data) > REMOTE_LIMITS.maxDetailBytes) return { ok: false, error: 'oversize' }
  let value: unknown
  try {
    value = JSON.parse(data)
  } catch {
    return { ok: false, error: 'malformed' }
  }
  if (!isRecord(value)) return { ok: false, error: 'malformed' }
  if (value.v !== PROTOCOL_VERSION) {
    return typeof value.v === 'number'
      ? { ok: false, error: 'unsupported-version' }
      : { ok: false, error: 'malformed' }
  }
  if (
    !hasKeys(value, ['v', 'type', 'session', 'generation', 'sentAt', 'result']) ||
    value.type !== 'messages' ||
    typeof value.session !== 'string' ||
    !SESSION_ID.test(value.session) ||
    !isCount(value.generation) ||
    !isTime(value.sentAt)
  ) {
    return { ok: false, error: 'malformed' }
  }
  const result = checkMessagesResult(value.result)
  return result === 'ok'
    ? { ok: true, response: value as unknown as MessagesResponse }
    : { ok: false, error: result }
}

function checkMessagesResult(value: unknown): 'ok' | 'malformed' | 'oversize' {
  if (!isRecord(value)) return 'malformed'
  if (value.state === 'unavailable') {
    return hasKeys(value, ['state', 'reason']) &&
      ['unreadable', 'unsupported', 'empty'].includes(value.reason as string)
      ? 'ok'
      : 'malformed'
  }
  if (value.state !== 'messages' || !hasKeys(value, ['state', 'entries', 'older'])) {
    return 'malformed'
  }
  const { entries } = value
  if (typeof value.older !== 'boolean' || !Array.isArray(entries)) return 'malformed'
  if (entries.length > REMOTE_LIMITS.maxEntries) return 'oversize'
  let textBytes = 0
  for (const entry of entries as unknown[]) {
    if (!isRecord(entry) || !isTime(entry.at)) return 'malformed'
    if (entry.kind === 'tool-calls') {
      const count = entry.count
      if (
        !hasKeys(entry, ['kind', 'count', 'at']) ||
        !Number.isSafeInteger(count) ||
        (count as number) < 1 ||
        (count as number) > REMOTE_LIMITS.maxToolCallCount
      ) {
        return 'malformed'
      }
      continue
    }
    if (
      (entry.kind !== 'prompt' && entry.kind !== 'reply') ||
      !hasKeys(entry, ['kind', 'text', 'at', 'cut']) ||
      typeof entry.text !== 'string' ||
      entry.text.length === 0 ||
      typeof entry.cut !== 'boolean'
    ) {
      return 'malformed'
    }
    textBytes += serializedTextBytes(entry.text)
    if (textBytes > REMOTE_LIMITS.maxMessageTextBytes) return 'oversize'
  }
  return 'ok'
}

/** What the viewer knows when a recent-messages response arrives. */
export interface MessagesBinding {
  /** The session whose detail is open now, or null. */
  openSession: string | null
  /** The last status frame the viewer accepted, or null. */
  lastStatus: StatusFrame | null
}

/**
 * Whether the viewer may show `response`: it is for the open session, no older than the last
 * status, and that status still lists the session with recent messages shared. Otherwise the
 * response is discarded unread.
 */
export function bindMessages(response: MessagesResponse, binding: MessagesBinding): boolean {
  const { openSession, lastStatus } = binding
  return (
    openSession !== null &&
    response.session === openSession &&
    lastStatus !== null &&
    response.generation >= lastStatus.generation &&
    detailsAllowed(lastStatus, openSession)
  )
}

/**
 * Whether an open detail may stay after `status` arrives: recent messages are shared and the
 * session is still listed. False means the viewer drops the text and any request in flight.
 */
export function detailsAllowed(status: StatusFrame, session: string): boolean {
  return (
    status.details &&
    status.status.projects.some((project) => project.sessions.some((row) => row.id === session))
  )
}
