import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  projectRemoteStatus,
  type RemoteStatusPolicy
} from '../../../core/remote/status-projection'
import type { SessionsSnapshot } from '../../../core/snapshot'
import type { SessionPaths } from '../../session-paths'
import { createSessionIdMinter } from '../session-ids'

// The localhost preview (TASK-037): shows the TASK-009 projection in a browser on this Mac before
// any listener, identity check or Tailscale work exists. It has no authentication, so it runs only
// on synthetic fixture data and only when a development switch asks for it. It reads snapshots and
// nothing else: it never calls the session controller, marks anything read or pins anything.

/** Set to `1`, together with fixture mode, to start the preview. */
export const PREVIEW_SWITCH = 'AGENTPEEK_REMOTE_PREVIEW'

/** At most two snapshots a second reach a viewer. */
export const PREVIEW_MIN_INTERVAL_MS = 500

/** A bound well above one page and one stream, so a stray loop cannot pile up sockets. */
export const PREVIEW_MAX_CONNECTIONS = 16

/** The fixture's one workspace (`scripts/fixture/records.mjs`), shared without titles. */
export const PREVIEW_SHARED_WORKSPACES = ['/Users/synthetic/projects/fixture-demo'] as const

/** A fixed synthetic per-viewer secret; TASK-014 stores or derives the real one. */
const PREVIEW_SECRET = Buffer.from('agentpeek-localhost-preview-synthetic-secret', 'utf8')

const LOOPBACK = '127.0.0.1'

const PAGE_SCRIPT = `const out = document.getElementById('status')
const state = document.getElementById('state')
const events = new EventSource('/events')
events.addEventListener('status', (event) => {
  state.textContent = 'Live'
  out.textContent = JSON.stringify(JSON.parse(event.data), null, 2)
})
events.addEventListener('error', () => {
  state.textContent = 'Disconnected'
})`

const PAGE_STYLE =
  'body{font:14px -apple-system,system-ui,sans-serif;margin:16px}pre{white-space:pre-wrap}'

const hash = (text: string) => `'sha256-${createHash('sha256').update(text).digest('base64')}'`

/** Same origin only; the one inline script and style are allowed by their hashes. */
export const PREVIEW_CSP = [
  "default-src 'none'",
  `script-src ${hash(PAGE_SCRIPT)}`,
  "connect-src 'self'",
  `style-src ${hash(PAGE_STYLE)}`,
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ')

// A stub until TASK-038 designs the page. Only the script fills it, and only with textContent.
const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AgentPeek preview</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<h1>AgentPeek preview</h1>
<p>Synthetic fixture data. <span id="state">Connecting…</span></p>
<pre id="status"></pre>
<script>${PAGE_SCRIPT}</script>
</body>
</html>
`

const COMMON_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': PREVIEW_CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin'
} as const

export interface PreviewServer {
  /** `http://127.0.0.1:<port>`. */
  readonly url: string
  /** Hands over a new snapshot; viewers get its projection within the coalescing interval. */
  publish(snapshot: SessionsSnapshot): void
  /** Ends every stream, stops the timer and closes the socket. Safe to call more than once. */
  close(): Promise<void>
}

export interface PreviewOptions {
  /** The latest published snapshot, for a viewer that connects between snapshots. */
  snapshot: () => SessionsSnapshot
  now?: () => number
}

/** The preview runs only when the switch is set and the paths are a fixture home. */
export function shouldStartPreview(
  env: Record<string, string | undefined>,
  paths: Pick<SessionPaths, 'fixture'>
): boolean {
  return env[PREVIEW_SWITCH] === '1' && paths.fixture
}

/** Listens on 127.0.0.1 only, on a port the OS picks. */
export async function startPreviewServer(options: PreviewOptions): Promise<PreviewServer> {
  const now = options.now ?? Date.now
  const policy: RemoteStatusPolicy = {
    sharedWorkspaces: PREVIEW_SHARED_WORKSPACES,
    shareTitles: false,
    mintId: createSessionIdMinter(PREVIEW_SECRET)
  }
  const streams = new Set<ServerResponse>()
  let origin = ''
  let latest = options.snapshot()
  let sent: string | null = null
  let sentAt = -Infinity
  let timer: ReturnType<typeof setTimeout> | undefined
  let closing: Promise<void> | null = null

  const frame = (snapshot: SessionsSnapshot) =>
    `event: status\ndata: ${JSON.stringify(projectRemoteStatus(snapshot, policy))}\n\n`

  function flush(): void {
    timer = undefined
    if (closing || streams.size === 0) return
    const data = frame(latest)
    if (data === sent) return
    sent = data
    sentAt = now()
    for (const stream of streams) stream.write(data)
  }

  function schedule(): void {
    if (closing || timer || streams.size === 0) return
    const wait = sentAt + PREVIEW_MIN_INTERVAL_MS - now()
    if (wait <= 0) flush()
    else timer = setTimeout(flush, wait)
  }

  function reject(response: ServerResponse, status: number, extra: Record<string, string> = {}) {
    response.writeHead(status, { ...COMMON_HEADERS, ...extra, 'Content-Type': 'text/plain' })
    response.end()
  }

  function handle(request: IncomingMessage, response: ServerResponse): void {
    // Exact Host and Origin stop DNS rebinding: another site's page never names 127.0.0.1:port.
    if (request.headers.host !== origin.slice('http://'.length)) return reject(response, 421)
    const requestOrigin = request.headers.origin
    if (requestOrigin !== undefined && requestOrigin !== origin) return reject(response, 403)
    if (request.method !== 'GET') return reject(response, 405, { Allow: 'GET' })
    if (request.url === '/') {
      response.writeHead(200, { ...COMMON_HEADERS, 'Content-Type': 'text/html; charset=utf-8' })
      response.end(PAGE)
      return
    }
    if (request.url !== '/events') return reject(response, 404)
    response.writeHead(200, {
      ...COMMON_HEADERS,
      'Content-Type': 'text/event-stream; charset=utf-8',
      Connection: 'keep-alive'
    })
    // Each viewer starts from a complete snapshot, outside the coalescing of later ones.
    response.write(frame(latest))
    streams.add(response)
    response.on('close', () => streams.delete(response))
  }

  const server = createServer(handle)
  server.maxConnections = PREVIEW_MAX_CONNECTIONS
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    // An explicit host: without it Node listens on every interface.
    server.listen({ host: LOOPBACK, port: 0, exclusive: true }, () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address() as AddressInfo
  // From the bound address, so a listener on any other interface shows in the URL and its tests.
  origin = `http://${address.address}:${address.port}`

  return {
    url: origin,
    publish(snapshot) {
      latest = snapshot
      schedule()
    },
    close() {
      closing ??= new Promise<void>((resolve) => {
        clearTimeout(timer)
        timer = undefined
        for (const stream of streams) stream.end()
        streams.clear()
        server.close(() => resolve())
        // An open stream must not hold quit: drop every socket now.
        server.closeAllConnections()
      })
      return closing
    }
  }
}
