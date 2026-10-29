import {
  decodeFrame,
  PROTOCOL_VERSION,
  reconnectDelayMs,
  REMOTE_ERROR_STATUS,
  REMOTE_LIMITS,
  REMOTE_ROUTES,
  type RemoteErrorCode,
  type StatusFrame
} from '../../../src/core/remote/protocol'

// The viewer's connection to the Mac (TASK-017): one `fetch` of the status stream, read with a
// stream reader so the typed HTTP errors stay visible (`EventSource` hides them). It holds the last
// status in memory only: nothing goes to browser storage, history or caches, and the data is
// dropped as soon as access ends. Only the Mac grants access, by the login Serve adds; the page
// never sends or shows one.

/** What the page shows from the stream, kept in memory only. */
export interface ViewerData {
  /** The last full status. Every status replaces everything before it. */
  frame: StatusFrame
  /** The Mac clock of the latest frame of any type: "checked" and "showing data from". */
  lastSentAt: number
}

export type ViewerState =
  /** First load, before the first status. */
  | { kind: 'connecting' }
  | { kind: 'live'; data: ViewerData }
  /** The stream dropped; it reconnects with backoff and dims the last data, if any. */
  | { kind: 'reconnecting'; data: ViewerData | null }
  /** Several attempts in a row failed: AgentPeek closed, the Mac asleep or offline. Still retries. */
  | { kind: 'lost'; data: ViewerData | null }
  /** Five viewer pages are open already. Retries with backoff. */
  | { kind: 'busy'; data: ViewerData | null }
  /** The owner turned Remote View off: data cleared, retries slowly until it is on again. */
  | { kind: 'off' }
  // Final states: data cleared, no retry.
  /** The Mac refused the login Serve sent, or Serve sent none. */
  | { kind: 'not-allowed' }
  /** The page was opened from an address other than the one set on the Mac. */
  | { kind: 'bad-host' }
  /** The page and the Mac speak different protocol versions; a reload fixes it. */
  | { kind: 'update-needed' }
  /** The Mac answered a request this page should never make. */
  | { kind: 'failed' }

export interface ConnectionOptions {
  fetch: typeof fetch
  onChange: (state: ViewerState) => void
  random?: () => number
  setTimer?: (run: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
}

export interface Connection {
  start(): void
  /** The Retry button: reconnect now instead of waiting for the backoff. */
  retryNow(): void
  /** Ends the stream and every timer, for example when the page goes away. */
  stop(): void
}

/** Failed attempts in a row before "Reconnecting" turns into "Connection lost". */
export const LOST_AFTER_FAILURES = 3

/** After `remote-off`, retries start at this attempt, so they come every few seconds at most. */
const OFF_RETRY_ATTEMPT = 3

/** An event's two lines may not exceed the frame budget by more than their field names. */
const MAX_EVENT_CHARS = REMOTE_LIMITS.maxFrameBytes + 64

const ERROR_CODES = new Set(Object.keys(REMOTE_ERROR_STATUS))

export function createConnection(options: ConnectionOptions): Connection {
  const random = options.random ?? Math.random
  const setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms))
  const clearTimer =
    options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>))
  let state: ViewerState = { kind: 'connecting' }
  /** Reconnect attempts since the last status frame, for the backoff. */
  let attempt = 0
  /** Failed attempts in a row, for "Connection lost". */
  let failures = 0
  let timer: unknown
  let abort: AbortController | null = null
  let stopped = false

  function set(next: ViewerState): void {
    state = next
    options.onChange(next)
  }

  function dataOf(current: ViewerState): ViewerData | null {
    return 'data' in current ? current.data : null
  }

  function connectSoon(ms: number): void {
    clearTimer(timer)
    timer = setTimer(() => {
      timer = undefined
      void connect()
    }, ms)
  }

  /** A drop or a failed attempt: keep the last data dimmed and try again with backoff. */
  function retry(kind: 'reconnecting' | 'busy' = 'reconnecting'): void {
    failures += 1
    if (state.kind === 'off') {
      // Stays "off" until a status arrives; the listener is gone, so this is the slow path.
    } else if (kind === 'busy') {
      set({ kind: 'busy', data: dataOf(state) })
    } else {
      const data = dataOf(state)
      set(failures >= LOST_AFTER_FAILURES ? { kind: 'lost', data } : { kind: 'reconnecting', data })
    }
    connectSoon(reconnectDelayMs(attempt, random))
    attempt += 1
  }

  /** Ends access for good on this page: the data goes with it and nothing retries. */
  function finish(kind: 'not-allowed' | 'bad-host' | 'update-needed' | 'failed'): void {
    stopStream()
    set({ kind })
  }

  function refused(code: RemoteErrorCode | null): void {
    switch (code) {
      case 'not-allowed':
        return finish('not-allowed')
      case 'bad-host':
      case 'bad-origin':
        return finish('bad-host')
      case 'unsupported-version':
        return finish('update-needed')
      case 'busy':
        return retry('busy')
      case 'method-not-allowed':
      case 'bad-request':
      case 'not-found':
        return finish('failed')
      default:
        // `rate-limited`, or not AgentPeek at all: Serve's own error while AgentPeek is closed.
        return retry()
    }
  }

  async function connect(): Promise<void> {
    if (stopped) return
    const controller = new AbortController()
    abort = controller
    let response: Response
    try {
      response = await options.fetch(REMOTE_ROUTES.status, {
        method: 'GET',
        headers: { Accept: 'text/event-stream' },
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal
      })
    } catch {
      if (abort !== controller) return
      abort = null
      return retry()
    }
    if (abort !== controller) return
    if (!response.ok) {
      const code = await errorCode(response)
      if (abort !== controller) return
      abort = null
      return refused(code)
    }
    if (!response.body || !isEventStream(response)) {
      void response.body?.cancel().catch(() => undefined)
      abort = null
      return retry()
    }
    const outcome = await read(response.body, controller)
    if (abort !== controller) return
    abort = null
    switch (outcome) {
      case 'remote-off':
        set({ kind: 'off' })
        attempt = OFF_RETRY_ATTEMPT
        return retry()
      case 'access-changed':
        // The login or address changed on the Mac: what this page showed may no longer be the
        // owner's to see. Clear it and ask once; `not-allowed` or `bad-host` then ends here.
        set({ kind: 'connecting' })
        attempt = 0
        failures = 0
        return connectSoon(reconnectDelayMs(0, random))
      case 'unsupported-version':
        return finish('update-needed')
      default:
        // `shutdown`, `slow-consumer`, a bad frame or a dropped connection.
        return retry()
    }
  }

  type ReadOutcome = 'remote-off' | 'access-changed' | 'unsupported-version' | 'dropped'

  /** Reads events until the stream ends. Every connection starts with a full status. */
  async function read(
    body: ReadableStream<Uint8Array>,
    controller: AbortController
  ): Promise<ReadOutcome> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    /** Within one stream the generation never decreases; a lower one is ignored. */
    let generation = -1
    const done = (outcome: ReadOutcome): ReadOutcome => {
      void reader.cancel().catch(() => undefined)
      return outcome
    }
    try {
      for (;;) {
        const chunk = await reader.read()
        if (abort !== controller) return done('dropped')
        if (chunk.done) return 'dropped'
        buffer += decoder.decode(chunk.value, { stream: true })
        let end: number
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          const event = parseEvent(buffer.slice(0, end))
          buffer = buffer.slice(end + 2)
          if (event === null) return done('dropped')
          const decoded = decodeFrame(event.type, event.data)
          if (!decoded.ok) {
            return done(decoded.error === 'unsupported-version' ? 'unsupported-version' : 'dropped')
          }
          const { frame } = decoded
          if (frame.type === 'end') {
            return done(
              frame.reason === 'remote-off' || frame.reason === 'access-changed'
                ? frame.reason
                : 'dropped'
            )
          }
          if (frame.generation < generation) continue
          generation = frame.generation
          if (frame.type === 'status') {
            attempt = 0
            failures = 0
            set({ kind: 'live', data: { frame, lastSentAt: frame.sentAt } })
          } else if (state.kind === 'live' && frame.snapshotId === state.data.frame.snapshotId) {
            set({ kind: 'live', data: { ...state.data, lastSentAt: frame.sentAt } })
          }
        }
        if (buffer.length > MAX_EVENT_CHARS) return done('dropped')
      }
    } catch {
      return 'dropped'
    }
  }

  function stopStream(): void {
    clearTimer(timer)
    timer = undefined
    abort?.abort()
    abort = null
  }

  return {
    start() {
      if (stopped || abort || timer !== undefined) return
      void connect()
    },
    retryNow() {
      if (stopped || abort) return
      if (state.kind !== 'lost' && state.kind !== 'busy' && state.kind !== 'reconnecting') return
      stopStream()
      void connect()
    },
    stop() {
      stopped = true
      stopStream()
    }
  }
}

/** One event as the listener writes it: `event: <type>` and one `data:` line. */
function parseEvent(text: string): { type: string; data: string } | null {
  const lines = text.split('\n')
  if (lines.length !== 2) return null
  const [type, data] = lines as [string, string]
  if (!type.startsWith('event: ') || !data.startsWith('data: ')) return null
  return { type: type.slice('event: '.length), data: data.slice('data: '.length) }
}

function isEventStream(response: Response): boolean {
  return (response.headers.get('content-type') ?? '').startsWith('text/event-stream')
}

/** The typed code of an AgentPeek error reply, or null for anything else (such as Serve's 502). */
async function errorCode(response: Response): Promise<RemoteErrorCode | null> {
  if (!(response.headers.get('content-type') ?? '').startsWith('application/json')) {
    void response.body?.cancel().catch(() => undefined)
    return null
  }
  try {
    const text = await response.text()
    if (text.length > 256) return null
    const body: unknown = JSON.parse(text)
    if (typeof body !== 'object' || body === null) return null
    const { v, error } = body as Record<string, unknown>
    return v === PROTOCOL_VERSION && typeof error === 'string' && ERROR_CODES.has(error)
      ? (error as RemoteErrorCode)
      : null
  } catch {
    return null
  }
}
