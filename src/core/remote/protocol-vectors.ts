import {
  PROTOCOL_VERSION,
  type RemoteAccessConfig,
  type RemoteErrorCode,
  type RemoteRequest,
  type DecodeError,
  type MessagesResponse,
  type StatusFrame
} from './protocol'

// Protocol v1 test vectors (TASK-003), shared by the protocol tests here and by the listener and
// viewer tests of later cards. Synthetic values only: no real login, host, title or path.

export const VECTOR_CONFIG: RemoteAccessConfig = {
  ownerLogin: 'owner@example.com',
  hostName: 'synthetic-mac.tail0000.ts.net'
}

const ORIGIN = `https://${VECTOR_CONFIG.hostName}`

/** Headers that Serve sends for the owner's browser on the status route. */
export const OWNER_HEADERS = {
  'tailscale-user-login': VECTOR_CONFIG.ownerLogin,
  host: VECTOR_CONFIG.hostName,
  origin: ORIGIN
} as const

function request(
  headers: Record<string, string | readonly string[] | undefined>,
  target = '/v2/status',
  method = 'GET'
): RemoteRequest {
  return { method, target, headers: { ...OWNER_HEADERS, ...headers } }
}

export interface RequestVector {
  name: string
  request: RemoteRequest
  /** The route on success, or the error code. */
  expected: 'page' | 'status' | 'asset' | 'messages' | RemoteErrorCode
}

export const REQUEST_VECTORS: readonly RequestVector[] = [
  { name: 'owner opens the page', request: request({ origin: undefined }, '/'), expected: 'page' },
  { name: 'owner opens the status stream', request: request({}), expected: 'status' },
  {
    name: 'owner loads a hashed asset',
    request: request({ origin: undefined }, '/assets/index-Ab12_cd.js'),
    expected: 'asset'
  },
  {
    name: 'login surrounded by spaces is trimmed',
    request: request({ 'tailscale-user-login': `  ${VECTOR_CONFIG.ownerLogin} ` }),
    expected: 'status'
  },
  {
    name: 'Host differing only in case',
    request: request({ host: VECTOR_CONFIG.hostName.toUpperCase() }),
    expected: 'status'
  },
  // Identity comes first: without the owner's login nothing else is revealed.
  {
    name: 'missing login (direct loopback, tagged device or Funnel)',
    request: request({ 'tailscale-user-login': undefined }),
    expected: 'not-allowed'
  },
  {
    name: 'another tailnet user',
    request: request({ 'tailscale-user-login': 'someone-else@example.com' }),
    expected: 'not-allowed'
  },
  {
    name: 'login differing in case',
    request: request({ 'tailscale-user-login': 'Owner@example.com' }),
    expected: 'not-allowed'
  },
  {
    name: 'two login values joined by a comma',
    request: request({ 'tailscale-user-login': `${VECTOR_CONFIG.ownerLogin}, x@example.com` }),
    expected: 'not-allowed'
  },
  {
    name: 'repeated login header',
    request: request({
      'tailscale-user-login': [VECTOR_CONFIG.ownerLogin, VECTOR_CONFIG.ownerLogin]
    }),
    expected: 'not-allowed'
  },
  {
    name: 'wrong login and wrong Host reports only the login',
    request: request({ 'tailscale-user-login': 'x@example.com', host: 'evil.example' }),
    expected: 'not-allowed'
  },
  {
    name: 'loopback Host copied from the preview',
    request: request({ host: '127.0.0.1:49233' }),
    expected: 'bad-host'
  },
  { name: 'rebinding Host', request: request({ host: 'evil.example' }), expected: 'bad-host' },
  {
    name: 'Host with a port',
    request: request({ host: `${VECTOR_CONFIG.hostName}:443` }),
    expected: 'bad-host'
  },
  {
    name: 'Host with a suffix',
    request: request({ host: `${VECTOR_CONFIG.hostName}.evil.example` }),
    expected: 'bad-host'
  },
  { name: 'missing Host', request: request({ host: undefined }), expected: 'bad-host' },
  {
    name: 'foreign Origin',
    request: request({ origin: 'https://evil.example' }),
    expected: 'bad-origin'
  },
  {
    name: 'plain-HTTP Origin',
    request: request({ origin: `http://${VECTOR_CONFIG.hostName}` }),
    expected: 'bad-origin'
  },
  { name: 'opaque Origin', request: request({ origin: 'null' }), expected: 'bad-origin' },
  { name: 'POST', request: request({}, '/v2/status', 'POST'), expected: 'method-not-allowed' },
  { name: 'HEAD', request: request({}, '/', 'HEAD'), expected: 'method-not-allowed' },
  {
    name: 'GET with a body',
    request: request({ 'content-length': '12' }),
    expected: 'bad-request'
  },
  {
    name: 'GET with chunked body',
    request: request({ 'transfer-encoding': 'chunked' }),
    expected: 'bad-request'
  },
  {
    name: 'overlong target',
    request: request({}, `/${'a'.repeat(2048)}`),
    expected: 'bad-request'
  },
  {
    name: 'absolute-form target',
    request: request({}, `https://${VECTOR_CONFIG.hostName}/v2/status`),
    expected: 'bad-request'
  },
  {
    name: 'unknown protocol version',
    request: request({}, '/v3/status'),
    expected: 'unsupported-version'
  },
  { name: 'query string', request: request({}, '/v2/status?resume=1'), expected: 'not-found' },
  { name: 'path traversal', request: request({}, '/assets/../main.js'), expected: 'not-found' },
  { name: 'desktop action name', request: request({}, '/v2/markRead'), expected: 'not-found' },
  { name: 'old preview stream path', request: request({}, '/events'), expected: 'not-found' },
  // Protocol v2 retired v1 in the same build: an open v1 page is told to reload.
  {
    name: 'v1 status stream',
    request: request({}, '/v1/status'),
    expected: 'unsupported-version'
  },
  {
    name: 'v1 recent messages',
    request: request({}, `/v1/sessions/${'A'.repeat(22)}/messages`),
    expected: 'unsupported-version'
  },
  {
    name: 'recent messages of an opaque session',
    request: request({}, `/v2/sessions/${'A'.repeat(22)}/messages`),
    expected: 'messages'
  },
  {
    name: 'recent messages with a short ID',
    request: request({}, '/v2/sessions/abc/messages'),
    expected: 'not-found'
  },
  {
    name: 'recent messages with a query string',
    request: request({}, `/v2/sessions/${'A'.repeat(22)}/messages?limit=500`),
    expected: 'not-found'
  },
  {
    name: 'recent messages by a raw path',
    request: request({}, '/v2/sessions/%2FUsers%2Fsynthetic/messages'),
    expected: 'not-found'
  },
  {
    name: 'POST recent messages',
    request: request({}, `/v2/sessions/${'A'.repeat(22)}/messages`, 'POST'),
    expected: 'method-not-allowed'
  }
]

/** A complete, valid status frame: one project, one waiting session. */
export const VALID_STATUS_FRAME: StatusFrame = {
  v: PROTOCOL_VERSION,
  type: 'status',
  snapshotId: 'r7Kq2-12',
  generation: 3,
  observedAt: 1_800_000_000_000,
  sentAt: 1_800_000_004_000,
  details: false,
  status: {
    observedAt: 1_800_000_000_000,
    sources: {
      codex: { state: 'connected', lastReadAt: 1_800_000_000_000 },
      claude: { state: 'no-access', lastReadAt: null }
    },
    projects: [
      {
        label: 'synthetic-project',
        sessions: [
          {
            id: 'AAAAAAAAAAAAAAAAAAAAAA',
            tool: 'claude',
            title: 'Session 1',
            activity: { state: 'waiting', kind: 'permission' },
            attention: { waiting: true, newReply: false, error: false },
            attentionSince: null,
            lastActivityAt: 1_799_999_880_000
          }
        ]
      }
    ],
    omitted: { projects: 0, sessions: 0 }
  }
}

/**
 * The frame the Mac sends after the owner narrows sharing: a new generation and snapshot ID and a
 * complete replacement in which the unshared project is simply absent, not marked removed.
 */
export const NARROWED_STATUS_FRAME: StatusFrame = {
  ...VALID_STATUS_FRAME,
  snapshotId: 'r7Kq2-13',
  generation: 4,
  sentAt: 1_800_000_009_000,
  status: { ...VALID_STATUS_FRAME.status, projects: [] }
}

export const HEARTBEAT_DATA = JSON.stringify({
  v: PROTOCOL_VERSION,
  type: 'heartbeat',
  snapshotId: 'r7Kq2-12',
  generation: 3,
  sentAt: 1_800_000_019_000
})

export interface DecodeVector {
  name: string
  event: string
  data: string
  expected: 'ok' | DecodeError
}

const valid = VALID_STATUS_FRAME
const project = valid.status.projects[0]!
const row = project.sessions[0]!

/** A status frame with one change, as JSON. */
function statusWith(change: (frame: Record<string, unknown>) => void): string {
  const frame = structuredClone(valid) as unknown as Record<string, unknown>
  change(frame)
  return JSON.stringify(frame)
}

function rowWith(change: (session: Record<string, unknown>) => void): string {
  return statusWith((frame) => {
    const status = frame.status as { projects: { sessions: Record<string, unknown>[] }[] }
    change(status.projects[0]!.sessions[0]!)
  })
}

export const DECODE_VECTORS: readonly DecodeVector[] = [
  { name: 'valid status', event: 'status', data: JSON.stringify(valid), expected: 'ok' },
  {
    name: 'narrowed replacement',
    event: 'status',
    data: JSON.stringify(NARROWED_STATUS_FRAME),
    expected: 'ok'
  },
  { name: 'heartbeat', event: 'heartbeat', data: HEARTBEAT_DATA, expected: 'ok' },
  {
    name: 'end',
    event: 'end',
    data: JSON.stringify({ v: PROTOCOL_VERSION, type: 'end', reason: 'remote-off' }),
    expected: 'ok'
  },
  {
    name: 'retired v1 frame',
    event: 'status',
    data: statusWith((frame) => (frame.v = 1)),
    expected: 'unsupported-version'
  },
  {
    name: 'unknown version',
    event: 'status',
    data: statusWith((frame) => (frame.v = 3)),
    expected: 'unsupported-version'
  },
  {
    name: 'status with recent messages shared',
    event: 'status',
    data: statusWith((frame) => (frame.details = true)),
    expected: 'ok'
  },
  {
    name: 'status without details (a v1 shape under v2)',
    event: 'status',
    data: statusWith((frame) => delete frame.details),
    expected: 'malformed'
  },
  {
    name: 'details as text',
    event: 'status',
    data: statusWith((frame) => (frame.details = 'true')),
    expected: 'malformed'
  },
  {
    name: 'version as text',
    event: 'status',
    data: statusWith((frame) => (frame.v = '1')),
    expected: 'malformed'
  },
  { name: 'not JSON', event: 'status', data: '{"v":2,', expected: 'malformed' },
  { name: 'array', event: 'status', data: '[1]', expected: 'malformed' },
  {
    name: 'event name does not match type',
    event: 'heartbeat',
    data: JSON.stringify(valid),
    expected: 'malformed'
  },
  {
    name: 'unknown event',
    event: 'command',
    data: '{"v":2,"type":"command"}',
    expected: 'malformed'
  },
  {
    name: 'oversize',
    event: 'status',
    data: JSON.stringify({ ...valid, padding: 'x'.repeat(192 * 1024) }),
    expected: 'oversize'
  },
  {
    name: 'extra top-level field',
    event: 'status',
    data: statusWith((frame) => (frame.fixtureHome = '/Users/synthetic')),
    expected: 'malformed'
  },
  {
    name: 'raw workspace path on a project',
    event: 'status',
    data: statusWith((frame) => {
      const status = frame.status as { projects: Record<string, unknown>[] }
      status.projects[0]!.workspacePath = '/Users/synthetic/projects/app'
    }),
    expected: 'malformed'
  },
  {
    name: 'raw session ID instead of an opaque one',
    event: 'status',
    data: rowWith((session) => (session.id = '019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b')),
    expected: 'malformed'
  },
  {
    name: 'tool text in a waiting session',
    event: 'status',
    data: rowWith(
      (session) => (session.activity = { state: 'waiting', waitingFor: 'permission prompt' })
    ),
    expected: 'malformed'
  },
  {
    name: 'unlisted waiting kind',
    event: 'status',
    data: rowWith((session) => (session.activity = { state: 'waiting', kind: 'approval' })),
    expected: 'malformed'
  },
  {
    name: 'error text on a session',
    event: 'status',
    data: rowWith((session) => (session.errorCode = 'rate_limit')),
    expected: 'malformed'
  },
  {
    name: 'title over 160 code points',
    event: 'status',
    data: rowWith((session) => (session.title = '𝒜'.repeat(161))),
    expected: 'malformed'
  },
  {
    name: 'empty title',
    event: 'status',
    data: rowWith((session) => (session.title = '')),
    expected: 'malformed'
  },
  {
    name: 'unknown tool',
    event: 'status',
    data: rowWith((session) => (session.tool = 'cursor')),
    expected: 'malformed'
  },
  {
    name: 'negative generation',
    event: 'status',
    data: statusWith((frame) => (frame.generation = -1)),
    expected: 'malformed'
  },
  {
    name: 'fractional time',
    event: 'status',
    data: rowWith((session) => (session.lastActivityAt = 1.5)),
    expected: 'malformed'
  },
  {
    name: 'snapshot ID with a slash',
    event: 'status',
    data: statusWith((frame) => (frame.snapshotId = 'a/b')),
    expected: 'malformed'
  },
  {
    name: 'more than 250 rows',
    event: 'status',
    data: statusWith((frame) => {
      const status = frame.status as { projects: unknown[] }
      status.projects = [{ label: project.label, sessions: Array.from({ length: 251 }, () => row) }]
    }),
    expected: 'malformed'
  },
  {
    name: 'unknown end reason',
    event: 'end',
    data: JSON.stringify({ v: PROTOCOL_VERSION, type: 'end', reason: 'reboot' }),
    expected: 'malformed'
  }
]

// Protocol v2 recent-messages vectors (TASK-032). Synthetic text only.

const DETAIL_SESSION = row.id

/** A valid response for the session in `VALID_STATUS_FRAME`, under its generation. */
export const VALID_MESSAGES_RESPONSE: MessagesResponse = {
  v: PROTOCOL_VERSION,
  type: 'messages',
  session: DETAIL_SESSION,
  generation: VALID_STATUS_FRAME.generation,
  sentAt: 1_800_000_005_000,
  result: {
    state: 'messages',
    entries: [
      { kind: 'prompt', text: 'Synthetic prompt', at: 1_799_999_870_000, cut: false },
      { kind: 'tool-calls', count: 3, at: 1_799_999_875_000 },
      { kind: 'reply', text: 'Synthetic **reply**', at: 1_799_999_880_000, cut: false }
    ],
    older: false
  }
}

function messagesWith(change: (response: Record<string, unknown>) => void): string {
  const response = structuredClone(VALID_MESSAGES_RESPONSE) as unknown as Record<string, unknown>
  change(response)
  return JSON.stringify(response)
}

function entriesWith(change: (entries: Record<string, unknown>[]) => void): string {
  return messagesWith((response) => {
    change((response.result as { entries: Record<string, unknown>[] }).entries)
  })
}

const reply = (text: string) => ({ kind: 'reply', text, at: 1, cut: false })

export interface MessagesDecodeVector {
  name: string
  data: string
  expected: 'ok' | DecodeError
}

export const MESSAGES_DECODE_VECTORS: readonly MessagesDecodeVector[] = [
  { name: 'valid messages', data: JSON.stringify(VALID_MESSAGES_RESPONSE), expected: 'ok' },
  ...(['unreadable', 'unsupported', 'empty'] as const).map((reason) => ({
    name: `unavailable: ${reason}`,
    data: messagesWith((response) => (response.result = { state: 'unavailable', reason })),
    expected: 'ok' as const
  })),
  {
    name: 'unavailable with an unknown reason',
    data: messagesWith((r) => (r.result = { state: 'unavailable', reason: 'not-found' })),
    expected: 'malformed'
  },
  { name: 'extra key', data: messagesWith((r) => (r.path = '/x')), expected: 'malformed' },
  {
    name: 'extra key on an entry',
    data: entriesWith((entries) => (entries[0]!.names = ['Bash'])),
    expected: 'malformed'
  },
  {
    name: 'extra key on the result',
    data: messagesWith((r) => ((r.result as Record<string, unknown>).error = 'x')),
    expected: 'malformed'
  },
  {
    name: 'unknown kind',
    data: entriesWith((entries) => (entries[0]!.kind = 'attachment')),
    expected: 'malformed'
  },
  {
    name: 'tool-call count 0',
    data: entriesWith((entries) => (entries[1]!.count = 0)),
    expected: 'malformed'
  },
  {
    name: 'tool-call count over 10,000',
    data: entriesWith((entries) => (entries[1]!.count = 10_001)),
    expected: 'malformed'
  },
  {
    name: 'empty text',
    data: entriesWith((entries) => (entries[0]!.text = '')),
    expected: 'malformed'
  },
  {
    name: 'cut missing',
    data: entriesWith((entries) => delete entries[0]!.cut),
    expected: 'malformed'
  },
  {
    name: 'text over the limit',
    data: entriesWith((entries) => entries.splice(0, entries.length, reply('x'.repeat(65_535)))),
    expected: 'oversize'
  },
  {
    name: 'total over the limit',
    data: entriesWith((entries) =>
      entries.splice(0, entries.length, reply('x'.repeat(40_000)), reply('y'.repeat(40_000)))
    ),
    expected: 'oversize'
  },
  {
    name: '21 entries',
    data: entriesWith((entries) =>
      entries.splice(0, entries.length, ...Array.from({ length: 21 }, () => reply('x')))
    ),
    expected: 'oversize'
  },
  {
    name: 'response over 72 KiB',
    data: messagesWith((r) => (r.padding = 'x'.repeat(72 * 1024))),
    expected: 'oversize'
  },
  { name: 'v: 1', data: messagesWith((r) => (r.v = 1)), expected: 'unsupported-version' },
  { name: 'v as text', data: messagesWith((r) => (r.v = '2')), expected: 'malformed' },
  { name: 'status type', data: messagesWith((r) => (r.type = 'status')), expected: 'malformed' },
  {
    name: 'raw session ID',
    data: messagesWith((r) => (r.session = 'SENTINEL-RAW-ID')),
    expected: 'malformed'
  },
  { name: 'not JSON', data: '{"v":2,', expected: 'malformed' }
]
