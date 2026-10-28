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

// The TASK-038 thin-slice page: disposable, replaced by the web app under `remote/web/`. It builds
// every node with createElement and textContent, so nothing from the stream is parsed as markup.
const PAGE_SCRIPT = `const list = document.getElementById('projects')
const link = document.getElementById('link')
const sourcesLine = document.getElementById('sources')
const note = document.getElementById('note')
const TOOLS = { codex: 'Codex', claude: 'Claude Code' }
const ACTIVITY = { running: 'Running', waiting: 'Waiting', idle: 'Idle', unknown: 'Unknown' }
const UNKNOWN = {
  'process-ended': 'process ended',
  'app-not-running': 'app not running',
  quiet: 'no recent activity',
  unreadable: 'unreadable',
  unsupported: 'unsupported format'
}
const SOURCES = {
  off: 'off',
  checking: 'checking',
  'not-installed': 'not installed',
  unsupported: 'unsupported',
  connected: 'connected',
  'no-access': 'no access'
}
let status = null
let receivedAt = 0

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function ago(time) {
  const seconds = Math.max(0, Math.round((Date.now() - time) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return minutes + ' min ago'
  const hours = Math.round(minutes / 60)
  if (hours < 48) return hours + ' h ago'
  return Math.round(hours / 24) + ' d ago'
}

function clock(time) {
  return new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function row(session) {
  const item = el('li', 'row')
  const flags = []
  if (session.attention.error) flags.push(['error', 'Error'])
  if (session.attention.waiting) flags.push(['waiting', 'Needs you'])
  if (session.attention.newReply) flags.push(['reply', 'New reply'])
  if (flags.length > 0) item.classList.add('attention')
  const head = el('div', 'head')
  head.append(el('span', 'title', session.title), el('span', 'tool', TOOLS[session.tool] || session.tool))
  const meta = el('div', 'meta')
  const activity = session.activity
  const label = ACTIVITY[activity.state] || activity.state
  meta.append(el('span', 'activity ' + activity.state,
    activity.state === 'unknown' ? label + ' (' + (UNKNOWN[activity.reason] || activity.reason) + ')' : label))
  for (const [kind, text] of flags) meta.append(el('span', 'flag ' + kind, text))
  const time = el('time', 'time', ago(session.lastActivityAt))
  time.dateTime = new Date(session.lastActivityAt).toISOString()
  time.title = new Date(session.lastActivityAt).toLocaleString()
  meta.append(time)
  item.append(head, meta)
  return item
}

function render() {
  if (!status) return
  const parts = []
  for (const tool of Object.keys(TOOLS)) {
    const source = status.sources[tool]
    if (source) parts.push(TOOLS[tool] + ': ' + (SOURCES[source.state] || source.state))
  }
  sourcesLine.textContent = parts.join(' · ')
  const omitted = status.omitted
  note.textContent = omitted.projects + omitted.sessions > 0
    ? 'Not everything fits: ' + omitted.projects + ' projects and ' + omitted.sessions + ' sessions left out.'
    : ''
  const groups = []
  for (const project of status.projects) {
    const group = el('section', 'project')
    const counts = { waiting: 0, reply: 0, error: 0 }
    for (const session of project.sessions) {
      if (session.attention.waiting) counts.waiting += 1
      if (session.attention.newReply) counts.reply += 1
      if (session.attention.error) counts.error += 1
    }
    const summary = [project.sessions.length + ' sessions']
    if (counts.error) summary.push(counts.error + ' error')
    if (counts.waiting) summary.push(counts.waiting + ' need you')
    if (counts.reply) summary.push(counts.reply + ' new reply')
    const header = el('h2', null, project.label)
    header.append(el('span', 'count', summary.join(' · ')))
    const rows = el('ul', 'rows')
    for (const session of project.sessions) rows.append(row(session))
    if (project.sessions.length === 0) rows.append(el('li', 'empty', 'No sessions right now.'))
    group.append(header, rows)
    groups.push(group)
  }
  if (groups.length === 0) groups.push(el('p', 'empty', 'No shared projects.'))
  list.replaceChildren(...groups)
}

function showLink(state, text) {
  link.className = 'link ' + state
  link.textContent = text
}

const events = new EventSource('/events')
events.addEventListener('status', (event) => {
  status = JSON.parse(event.data)
  receivedAt = Date.now()
  showLink('live', 'Live · updated ' + clock(receivedAt))
  render()
})
events.addEventListener('error', () => {
  const since = receivedAt ? ' · showing data from ' + clock(receivedAt) : ''
  if (events.readyState === EventSource.CLOSED) showLink('down', 'Disconnected' + since)
  else showLink('stale', 'Reconnecting' + since)
})
setInterval(render, 30000)`

const PAGE_STYLE = `:root{color-scheme:light dark;--bg:#fff;--fg:#1d1d1f;--dim:#6e6e73;--line:#d2d2d7;--card:#f5f5f7;--red:#c9302c;--amber:#a15c00;--blue:#0a66c2;--green:#1e7f3c}
@media (prefers-color-scheme:dark){:root{--bg:#1c1c1e;--fg:#f5f5f7;--dim:#a1a1a6;--line:#3a3a3c;--card:#2c2c2e;--red:#ff6961;--amber:#ffb340;--blue:#64a8ff;--green:#5fd47e}}
*{box-sizing:border-box}
body{margin:0;padding:12px 16px 32px;background:var(--bg);color:var(--fg);font:14px/1.4 -apple-system,system-ui,sans-serif;max-width:860px}
header{position:sticky;top:0;background:var(--bg);padding:4px 0 8px;border-bottom:1px solid var(--line)}
h1{font-size:17px;margin:0 0 4px}
.sub{color:var(--dim);font-size:12px;margin:2px 0;overflow-wrap:anywhere}
.link{display:inline-block;font-size:12px;font-weight:600;padding:2px 8px;border-radius:10px;background:var(--card)}
.link.live{color:var(--green)}.link.stale{color:var(--amber)}.link.down{color:var(--red)}
.project{margin-top:16px}
h2{font-size:15px;margin:0 0 6px;display:flex;flex-wrap:wrap;gap:4px 8px;align-items:baseline;overflow-wrap:anywhere}
.count{font-size:12px;font-weight:400;color:var(--dim)}
.rows{list-style:none;margin:0;padding:0;border:1px solid var(--line);border-radius:8px}
.row{padding:8px 10px;border-top:1px solid var(--line)}
.row:first-child{border-top:0}
.row.attention{background:var(--card)}
.head,.meta{display:flex;flex-wrap:wrap;gap:2px 8px;align-items:baseline}
.title{font-weight:600;overflow-wrap:anywhere}
.tool,.time{color:var(--dim);font-size:12px}
.meta{font-size:12px;margin-top:2px}
.time{margin-left:auto}
.activity.running{color:var(--blue)}.activity.unknown{color:var(--dim)}
.flag{font-weight:600}.flag.error{color:var(--red)}.flag.waiting{color:var(--amber)}.flag.reply{color:var(--blue)}
.empty{color:var(--dim);padding:8px 10px}`

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

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AgentPeek preview</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<header>
<h1>AgentPeek preview</h1>
<p class="sub">Synthetic fixture data, this Mac only. <span id="link" class="link stale">Connecting…</span></p>
<p class="sub" id="sources"></p>
<p class="sub" id="note"></p>
</header>
<main id="projects"></main>
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
