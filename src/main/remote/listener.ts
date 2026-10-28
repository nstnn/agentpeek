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
import { projectRemoteStatus, type RemoteStatus } from '../../core/remote/status-projection'
import type { SessionsSnapshot } from '../../core/snapshot'
import { createSessionIdMinter } from './session-ids'
import type { ViewerFiles } from './viewer-files'

// The Remote View listener (TASK-014): binds 127.0.0.1 on the owner's port, which their
// `tailscale serve` publishes inside their tailnet. Every request passes the protocol v1 checks
// (`checkRemoteRequest`) before any work; the page and assets come from the viewer build, and the
// one status stream carries the TASK-009 projection of the existing snapshots. It reads snapshots
// and nothing else: it never calls the session controller, marks anything read or pins anything.
// Rate and buffer limits are TASK-022's; sharing policy and its generation bumps are TASK-015's.

const LOOPBACK = '127.0.0.1'

/** A bound well above five streams and a page load, so a stray loop cannot pile up sockets. */
export const REMOTE_MAX_CONNECTIONS = 16

/** How long quit waits for `end` frames to flush before it drops the remaining sockets. */
export const REMOTE_CLOSE_GRACE_MS = 200

/** What the owner shares. TASK-015 persists it; a change must come with a generation bump. */
export interface RemoteSharing {
  sharedWorkspaces: readonly string[]
  shareTitles: boolean
}

export const NOTHING_SHARED: RemoteSharing = { sharedWorkspaces: [], shareTitles: false }

export type RemoteStartError = 'port-in-use' | 'start-failed'

export interface RemoteListenerOptions {
  port: number
  access: RemoteAccessConfig
  /** Keys this listener's opaque session IDs. Each listener gets a fresh one. */
  secret: Uint8Array
  viewer: ViewerFiles
  /** The latest published snapshot, for a stream that opens between snapshots. */
  snapshot: () => SessionsSnapshot
  sharing: () => RemoteSharing
  /** The sharing-policy generation; it only grows. */
  generation: () => number
  now?: () => number
}

export interface RemoteListener {
  readonly port: number
  streamCount(): number
  /** Hands over a new snapshot; each stream gets it within its coalescing interval. */
  publish(snapshot: SessionsSnapshot): void
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
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ')

/** Everything else, error pages included: nothing may load or run. */
const LOCKED_CSP = "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

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
}

interface Current {
  snapshot: SessionsSnapshot
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
  const mintId = createSessionIdMinter(options.secret)
  const streams = new Set<Stream>()
  let latest = options.snapshot()
  let current: Current | null = null
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let closing: Promise<void> | null = null

  /** The projection of the latest snapshot under the current policy, made once per change. */
  function status(): Current {
    const generation = options.generation()
    if (current?.snapshot === latest && current.generation === generation) return current
    const projected = projectRemoteStatus(latest, { ...options.sharing(), mintId })
    // Every desktop snapshot has a new time, also one made for activity in a folder that is not
    // shared. A status that differs only in that time is the same status: it keeps its ID and its
    // `observedAt` (the last visible change) and is not sent again, so unshared activity stays
    // invisible.
    const visible = `${generation}\n${JSON.stringify({ ...projected, observedAt: 0 })}`
    if (current?.visible === visible) {
      current = { ...current, snapshot: latest }
      return current
    }
    const snapshotId = createHash('sha256').update(visible).digest('base64url').slice(0, 22)
    current = { snapshot: latest, generation, visible, snapshotId, status: projected }
    return current
  }

  function write(stream: Stream, frame: RemoteFrame): boolean {
    const { response } = stream
    if (response.writableEnded || response.destroyed) return false
    const encoded = encodeFrame(frame)
    if (!encoded.ok) return false
    response.write(encoded.event)
    return true
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
      timer: undefined
    }
    streams.add(stream)
    response.on('error', () => undefined)
    response.on('close', () => {
      clearTimeout(stream.timer)
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

  function handle(request: IncomingMessage, response: ServerResponse): void {
    if (closing) {
      request.socket.destroy()
      return
    }
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

  const server = createServer(handle)
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
    close(reason) {
      closing ??= new Promise<void>((resolve) => {
        clearInterval(heartbeat)
        heartbeat = undefined
        const ending = encodeFrame({ v: PROTOCOL_VERSION, type: 'end', reason })
        for (const stream of streams) {
          clearTimeout(stream.timer)
          stream.timer = undefined
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
