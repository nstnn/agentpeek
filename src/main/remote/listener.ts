import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  checkRemoteRequest,
  encodeFrame,
  errorBody,
  PROTOCOL_VERSION,
  REMOTE_ERROR_STATUS,
  REMOTE_LIMITS,
  type EndReason,
  type RemoteAccessConfig,
  type RemoteErrorCode,
  type RemoteFrame
} from '../../core/remote/protocol'
import type { RemoteSharing } from '../../core/remote/share-policy'
import { projectRemoteStatus, type RemoteStatus } from '../../core/remote/status-projection'
import type { SessionsSnapshot } from '../../core/snapshot'
import { createRateLimiter } from './rate-limit'
import { createSessionIdMinter } from './session-ids'
import type { ViewerFiles } from './viewer-files'

// The Remote View listener (TASK-014): binds 127.0.0.1 on the owner's port, which their
// `tailscale serve` publishes inside their tailnet. Every request passes the protocol v1 checks
// (`checkRemoteRequest`) before any work; the page and assets come from the viewer build, and the
// one status stream carries the TASK-009 projection of the existing snapshots. It reads snapshots
// and nothing else: it never calls the session controller, marks anything read or pins anything.
// The sharing policy and its generation are read again for every status it sends (TASK-015), so a
// status projected under an older policy never leaves. Resource limits (TASK-022) come before any
// work for a request: a global rate limit, request size and time, the stream cap, and a byte budget
// per stream.

const LOOPBACK = '127.0.0.1'

/** A bound well above five streams and a page load, so a stray loop cannot pile up sockets. */
export const REMOTE_MAX_CONNECTIONS = 16

/** How long quit, or a `slow-consumer` end, waits for frames to flush before dropping sockets. */
export const REMOTE_CLOSE_GRACE_MS = 200

/** Request line and headers, as Node's default; a larger request is `bad-request`. */
export const REMOTE_MAX_HEADER_BYTES = 16 * 1024

/**
 * How long a client may take to send a whole request. Every route is a GET without a body, so this
 * is the time to send the headers; Serve on the same Mac sends them at once.
 */
export const REMOTE_REQUEST_TIMEOUT_MS = 5_000

/** How often Node looks for requests over that time. */
const TIMEOUT_CHECK_INTERVAL_MS = 1_000

export type RemoteStartError = 'port-in-use' | 'start-failed'

export interface RemoteListenerOptions {
  port: number
  access: RemoteAccessConfig
  /** Keys this listener's opaque session IDs. Each listener gets a fresh one. */
  secret: Uint8Array
  viewer: ViewerFiles
  /** The latest published snapshot, for a stream that opens between snapshots. */
  snapshot: () => SessionsSnapshot
  /** The current policy; a change is a new object and comes with a new generation. */
  sharing: () => RemoteSharing
  /** The sharing-policy generation; it only grows. */
  generation: () => number
  /** The Mac clock: frame times, status coalescing and the request rate limit. */
  now?: () => number
  /** Tests shorten it; otherwise `REMOTE_REQUEST_TIMEOUT_MS`. */
  requestTimeoutMs?: number
}

export interface RemoteListener {
  readonly port: number
  streamCount(): number
  /** Hands over a new snapshot; each stream gets it within its coalescing interval. */
  publish(snapshot: SessionsSnapshot): void
  /**
   * After a policy change: drops every pending send and gives each stream the status under the
   * current policy now, ahead of coalescing.
   */
  resync(): void
  /** Ends every stream with `reason`, drops pending sends and closes the socket. Idempotent. */
  close(reason: EndReason): Promise<void>
}

export type RemoteListenerStart =
  { ok: true; listener: RemoteListener } | { ok: false; error: RemoteStartError }

const COMMON_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin'
} as const

/** The viewer page: its own scripts, styles and stream only (the page's meta CSP, plus framing). */
export const VIEWER_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self'",
  "worker-src 'none'",
  "child-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ')

/** Everything else, error pages included: nothing may load or run. */
const LOCKED_CSP = "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

/**
 * The reply to a request Node could not parse (oversize headers, malformed, too slow), written on
 * the socket because such a request never reaches the handler. Node's error text is never sent.
 */
const BAD_REQUEST_REPLY = (() => {
  const body = errorBody('bad-request')
  return [
    `HTTP/1.1 ${REMOTE_ERROR_STATUS['bad-request']} Bad Request`,
    ...Object.entries(COMMON_HEADERS).map(([name, value]) => `${name}: ${value}`),
    'Cache-Control: no-store',
    `Content-Security-Policy: ${LOCKED_CSP}`,
    'Content-Type: application/json',
    `Content-Length: ${Buffer.byteLength(body)}`,
    'Connection: close',
    '',
    body
  ].join('\r\n')
})()

/** Fixed copy (TASK-002) for a refused request to `/`, which never reaches the viewer page. */
const ERROR_PAGE_TEXT: Record<RemoteErrorCode, string> = {
  'not-allowed':
    'Not allowed. This page only opens for the Tailscale login set in AgentPeek on the Mac.',
  'bad-host': 'Open this page with the Mac address set in AgentPeek.',
  'bad-origin': 'Open this page with the Mac address set in AgentPeek.',
  'rate-limited': 'Too many requests. Wait a few seconds, then reload this page.',
  busy: 'Too many requests. Wait a few seconds, then reload this page.',
  'unsupported-version': 'AgentPeek on the Mac was updated. Reload this page.',
  'method-not-allowed': 'This request is not supported.',
  'bad-request': 'This request is not supported.',
  'not-found': 'This page does not exist.'
}

const errorPage = (text: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AgentPeek</title>
</head>
<body>
<h1>AgentPeek</h1>
<p>${text}</p>
</body>
</html>
`

interface Stream {
  response: ServerResponse
  /** The last status this stream got; null until the first one. */
  snapshotId: string | null
  generation: number
  lastStatusAt: number
  timer: ReturnType<typeof setTimeout> | undefined
  /** After a `slow-consumer` end: drops the socket if the frame cannot flush in time. */
  drop: ReturnType<typeof setTimeout> | undefined
}

interface Current {
  snapshot: SessionsSnapshot
  sharing: RemoteSharing
  generation: number
  /** The generation and the status without `observedAt`: what a viewer can tell apart. */
  visible: string
  snapshotId: string
  status: RemoteStatus
}

/**
 * Listens on 127.0.0.1 at exactly `options.port`. A port in use is a typed error; it never falls
 * back to another port or interface.
 */
export async function startRemoteListener(
  options: RemoteListenerOptions
): Promise<RemoteListenerStart> {
  const now = options.now ?? Date.now
  const requestTimeout = options.requestTimeoutMs ?? REMOTE_REQUEST_TIMEOUT_MS
  const mintId = createSessionIdMinter(options.secret)
  // Check 1 of the protocol. Every client arrives from loopback through Serve, so it is global: a
  // page load is four requests (five if the browser also asks for a favicon), and the burst covers
  // four or five viewers loading at once.
  const rate = createRateLimiter({
    perSecond: REMOTE_LIMITS.requestsPerSecond,
    burst: REMOTE_LIMITS.requestBurst,
    now
  })
  const streams = new Set<Stream>()
  /** The latest response on each connection, so a parse error never writes into an open one. */
  const responses = new WeakMap<object, ServerResponse>()
  let latest = options.snapshot()
  let current: Current | null = null
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let closing: Promise<void> | null = null

  /** The projection of the latest snapshot under the current policy, made once per change. */
  function status(): Current {
    const generation = options.generation()
    const sharing = options.sharing()
    if (
      current?.snapshot === latest &&
      current.sharing === sharing &&
      current.generation === generation
    ) {
      return current
    }
    const projected = projectRemoteStatus(latest, { ...sharing, mintId })
    // Every desktop snapshot has a new time, also one made for activity in a folder that is not
    // shared. A status that differs only in that time is the same status: it keeps its ID and its
    // `observedAt` (the last visible change) and is not sent again, so unshared activity stays
    // invisible.
    const visible = `${generation}\n${JSON.stringify({ ...projected, observedAt: 0 })}`
    if (current?.visible === visible) {
      current = { ...current, snapshot: latest, sharing }
      return current
    }
    const snapshotId = createHash('sha256').update(visible).digest('base64url').slice(0, 22)
    current = { snapshot: latest, sharing, generation, visible, snapshotId, status: projected }
    return current
  }

  function write(stream: Stream, frame: RemoteFrame): boolean {
    const { response } = stream
    if (response.writableEnded || response.destroyed) return false
    const encoded = encodeFrame(frame)
    if (!encoded.ok) return false
    // What the viewer has not taken yet, queued here and in the socket. A viewer that stops reading
    // gets an `end` instead of more frames, so it cannot grow the Mac's memory.
    const queued = response.writableLength + Buffer.byteLength(encoded.event)
    if (queued > REMOTE_LIMITS.maxBufferedBytesPerStream) {
      endSlowStream(stream)
      return false
    }
    response.write(encoded.event)
    return true
  }

  function endSlowStream(stream: Stream): void {
    clearTimeout(stream.timer)
    stream.timer = undefined
    const ending = encodeFrame({ v: PROTOCOL_VERSION, type: 'end', reason: 'slow-consumer' })
    stream.response.end(ending.ok ? ending.event : undefined)
    // The frame waits behind everything the viewer has not read; the socket goes if it stays stuck.
    stream.drop = setTimeout(() => stream.response.destroy(), REMOTE_CLOSE_GRACE_MS)
  }

  function sendStatus(stream: Stream): void {
    clearTimeout(stream.timer)
    stream.timer = undefined
    if (closing) return
    const { snapshotId, generation, status: body } = status()
    if (snapshotId === stream.snapshotId) return
    const sentAt = now()
    const frame: RemoteFrame = {
      v: PROTOCOL_VERSION,
      type: 'status',
      snapshotId,
      generation,
      observedAt: body.observedAt,
      sentAt,
      status: body
    }
    if (!write(stream, frame)) return
    stream.snapshotId = snapshotId
    stream.generation = generation
    stream.lastStatusAt = sentAt
  }

  /** At most one status per stream every 500 ms; the newest snapshot wins. */
  function schedule(stream: Stream): void {
    if (closing || stream.timer) return
    const wait = stream.lastStatusAt + REMOTE_LIMITS.minStatusIntervalMs - now()
    if (wait <= 0) sendStatus(stream)
    else stream.timer = setTimeout(() => sendStatus(stream), wait)
  }

  function beat(): void {
    const sentAt = now()
    for (const stream of streams) {
      if (stream.snapshotId === null) continue
      write(stream, {
        v: PROTOCOL_VERSION,
        type: 'heartbeat',
        snapshotId: stream.snapshotId,
        generation: stream.generation,
        sentAt
      })
    }
  }

  function refuse(response: ServerResponse, error: RemoteErrorCode, page: boolean): void {
    const headers: Record<string, string> = {
      ...COMMON_HEADERS,
      'Cache-Control': 'no-store',
      'Content-Security-Policy': LOCKED_CSP,
      // A refused connection is not reused, so an unread request body goes with it.
      Connection: 'close'
    }
    if (error === 'method-not-allowed') headers.Allow = 'GET'
    if (error === 'busy' || error === 'rate-limited') {
      headers['Retry-After'] = String(REMOTE_LIMITS.retryAfterSeconds)
    }
    const body = page ? errorPage(ERROR_PAGE_TEXT[error]) : errorBody(error)
    headers['Content-Type'] = page ? 'text/html; charset=utf-8' : 'application/json'
    response.writeHead(REMOTE_ERROR_STATUS[error], headers)
    response.end(body)
  }

  function serveFile(response: ServerResponse, body: Buffer, type: string, cache: string): void {
    response.writeHead(200, {
      ...COMMON_HEADERS,
      'Cache-Control': cache,
      'Content-Security-Policy': type.startsWith('text/html') ? VIEWER_CSP : LOCKED_CSP,
      'Content-Type': type,
      'Content-Length': String(body.byteLength)
    })
    response.end(body)
  }

  function openStream(response: ServerResponse): void {
    if (streams.size >= REMOTE_LIMITS.maxStreams) return refuse(response, 'busy', false)
    response.writeHead(200, {
      ...COMMON_HEADERS,
      'Cache-Control': 'no-store',
      'Content-Security-Policy': LOCKED_CSP,
      'Content-Type': 'text/event-stream; charset=utf-8',
      // The socket closes with the stream, so an `end` frame is followed by a clean close.
      Connection: 'close'
    })
    const stream: Stream = {
      response,
      snapshotId: null,
      generation: 0,
      lastStatusAt: -Infinity,
      timer: undefined,
      drop: undefined
    }
    streams.add(stream)
    response.on('error', () => undefined)
    response.on('close', () => {
      clearTimeout(stream.timer)
      clearTimeout(stream.drop)
      streams.delete(stream)
      if (streams.size === 0) {
        clearInterval(heartbeat)
        heartbeat = undefined
      }
    })
    // Every stream starts with a complete status, outside the coalescing of later ones.
    sendStatus(stream)
    heartbeat ??= setInterval(beat, REMOTE_LIMITS.heartbeatIntervalMs)
  }

  // Deliberately no request/error logging: the allowlist is empty. Headers, targets, exceptions
  // and status payloads can contain private text; only fixed protocol codes leave these handlers.
  function handle(request: IncomingMessage, response: ServerResponse): void {
    if (closing) {
      request.socket.destroy()
      return
    }
    responses.set(request.socket, response)
    if (!rate.take()) return refuse(response, 'rate-limited', request.url === '/')
    const decision = checkRemoteRequest(
      { method: request.method, target: request.url, headers: request.headers },
      options.access
    )
    if (!decision.ok) return refuse(response, decision.error, request.url === '/')
    const { route } = decision
    if (route.route === 'status') return openStream(response)
    if (route.route === 'page') {
      const page = options.viewer.page
      if (!page) return refuse(response, 'not-found', false)
      return serveFile(response, page, 'text/html; charset=utf-8', 'no-store')
    }
    const asset = options.viewer.assets.get(route.path)
    if (!asset) return refuse(response, 'not-found', false)
    serveFile(response, asset.body, asset.type, 'public, max-age=31536000, immutable')
  }

  const server = createServer(
    {
      maxHeaderSize: REMOTE_MAX_HEADER_BYTES,
      headersTimeout: requestTimeout,
      requestTimeout,
      connectionsCheckingInterval: TIMEOUT_CHECK_INTERVAL_MS,
      // A missing Host goes through the request checks (`bad-host`), not Node's untyped 400.
      requireHostHeader: false
    },
    handle
  )
  // Without these Node answers an `Expect` header itself, before the checks: `100-continue` with an
  // invitation to send a body they refuse, any other value with a bare 417. Every route goes
  // through every check, and HTTP allows serving an unknown expectation instead of the 417.
  server.on('checkContinue', handle)
  server.on('checkExpectation', handle)
  // A request Node could not parse never reaches `handle`. It gets the typed reply unless a response
  // is still being written on that connection, and the connection closes either way.
  server.on('clientError', (error: NodeJS.ErrnoException, socket) => {
    const open = responses.get(socket)
    if (error.code !== 'ECONNRESET' && socket.writable && (!open || open.writableFinished)) {
      socket.end(BAD_REQUEST_REPLY, () => socket.destroy())
    } else {
      socket.destroy()
    }
  })
  server.maxConnections = REMOTE_MAX_CONNECTIONS
  const failure = await new Promise<RemoteStartError | null>((resolve) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      resolve(error.code === 'EADDRINUSE' ? 'port-in-use' : 'start-failed')
    })
    // An explicit host: without it Node listens on every interface.
    server.listen({ host: LOOPBACK, port: options.port, exclusive: true }, () => resolve(null))
  })
  if (failure) return { ok: false, error: failure }
  server.removeAllListeners('error')
  server.on('error', () => undefined)
  const address = server.address() as AddressInfo
  if (address.address !== LOOPBACK || address.port !== options.port) {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    return { ok: false, error: 'start-failed' }
  }

  const listener: RemoteListener = {
    port: address.port,
    streamCount: () => streams.size,
    publish(snapshot) {
      if (closing) return
      latest = snapshot
      for (const stream of streams) schedule(stream)
    },
    resync() {
      if (closing) return
      for (const stream of streams) sendStatus(stream)
    },
    close(reason) {
      closing ??= new Promise<void>((resolve) => {
        clearInterval(heartbeat)
        heartbeat = undefined
        const ending = encodeFrame({ v: PROTOCOL_VERSION, type: 'end', reason })
        for (const stream of streams) {
          clearTimeout(stream.timer)
          stream.timer = undefined
          // The force close below covers a slow stream's socket too.
          clearTimeout(stream.drop)
          if (!stream.response.writableEnded) {
            stream.response.end(ending.ok ? ending.event : undefined)
          }
        }
        streams.clear()
        // A stream that cannot flush its `end` frame must not hold quit.
        const force = setTimeout(() => server.closeAllConnections(), REMOTE_CLOSE_GRACE_MS)
        server.close(() => {
          clearTimeout(force)
          resolve()
        })
        server.closeIdleConnections()
      })
      return closing
    }
  }
  return { ok: true, listener }
}
