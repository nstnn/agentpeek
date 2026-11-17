import {
  bindMessages,
  decodeMessages,
  detailsAllowed,
  REMOTE_LIMITS,
  REMOTE_ROUTES,
  type MessageEntry,
  type RemoteErrorCode,
  type StatusFrame
} from '../../../src/core/remote/protocol'
import { errorCode } from './connection'

// One session's recent messages (TASK-033), under the viewer binding of protocol v2. The text
// lives only in the current `DetailState`, in page memory: it is never written to storage, the
// URL, history state or the console, and every new state drops the previous one. A response is
// shown only if it validates, names the open session, is no older than the last status and that
// status still lists the session with `details: true`; anything else is discarded unread.

/** What the open detail shows. Only `messages` holds text. */
export type DetailView =
  | { kind: 'loading' }
  | { kind: 'messages'; entries: MessageEntry[]; older: boolean }
  /** `gone`: the Mac answered `not-found`, or the status no longer lists the session. */
  | { kind: 'unavailable'; reason: 'unreadable' | 'unsupported' | 'empty' | 'gone' }
  /** "Share recent messages" is off on the Mac. */
  | { kind: 'not-shared' }
  /** The status stream is not live; the text was dropped and comes back with it. */
  | { kind: 'paused' }
  /** A bad answer, a network error or a second `busy`/`policy-changed`. Retry asks again. */
  | { kind: 'failed' }

export interface DetailState {
  session: string
  view: DetailView
}

export interface DetailsOptions {
  fetch: typeof fetch
  /** Null when no detail is open. */
  onChange: (state: DetailState | null) => void
  /** A monotonic local clock in milliseconds. */
  now?: () => number
  setTimer?: (run: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
}

export interface Details {
  /** Opens (or switches to) one session's detail and asks the Mac for it. */
  open(session: string): void
  /** Leaves the detail: drops the text and aborts what is in flight. */
  close(): void
  /** Each status the page accepts while live. */
  status(frame: StatusFrame): void
  /** The stream is not live (dropped, reconnecting, page hidden): drop the text, keep the session. */
  pause(): void
  /** The Retry button after `failed`. */
  retry(): void
}

export function createDetails(options: DetailsOptions): Details {
  const now = options.now ?? (() => performance.now())
  const setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms))
  const clearTimer =
    options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>))

  let state: DetailState | null = null
  /** The last status accepted while live; null while paused, so no late response can bind. */
  let lastStatus: StatusFrame | null = null
  let abort: AbortController | null = null
  /** Bumped by every request and every reset, so an older answer finds itself stale. */
  let token = 0
  let timer: unknown
  let lastRequestAt = -Infinity
  /** The generation the shown text (or the request for it) was asked under. */
  let askedGeneration = -1
  let lastActivityAt: number | null = null
  /** `policy-changed` waits for the next status, once. */
  let retryOnStatus = false
  let policyRetried = false
  let busyRetried = false

  function set(next: DetailState | null): void {
    state = next
    options.onChange(next)
  }

  function show(view: DetailView): void {
    if (state) set({ session: state.session, view })
  }

  /** Aborts the request and every timer; the answer to it, if any, is now stale. */
  function cancel(): void {
    token += 1
    abort?.abort()
    abort = null
    clearTimer(timer)
    timer = undefined
    retryOnStatus = false
  }

  function rowOf(frame: StatusFrame, session: string) {
    for (const project of frame.status.projects) {
      const row = project.sessions.find((candidate) => candidate.id === session)
      if (row) return row
    }
    return null
  }

  /** Asks for the open session; keeps the text shown when it is only a refresh. */
  function request(keepText = false): void {
    if (!state || !lastStatus || !detailsAllowed(lastStatus, state.session)) return
    cancel()
    const session = state.session
    const mine = token
    const controller = new AbortController()
    abort = controller
    askedGeneration = lastStatus.generation
    lastRequestAt = now()
    lastActivityAt = rowOf(lastStatus, session)?.lastActivityAt ?? null
    if (!(keepText && state.view.kind === 'messages')) show({ kind: 'loading' })
    void ask(session, mine, controller)
  }

  async function ask(session: string, mine: number, controller: AbortController): Promise<void> {
    let response: Response
    try {
      response = await options.fetch(REMOTE_ROUTES.messages(session), {
        method: 'GET',
        headers: { Accept: 'application/json' },
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal
      })
    } catch {
      if (mine === token) show({ kind: 'failed' })
      return
    }
    if (mine !== token) {
      void response.body?.cancel().catch(() => undefined)
      return
    }
    if (!response.ok) {
      const code = await errorCode(response)
      if (mine === token) refused(code)
      return
    }
    const length = Number(response.headers.get('content-length') ?? 0)
    if (length > REMOTE_LIMITS.maxDetailBytes) {
      void response.body?.cancel().catch(() => undefined)
      return show({ kind: 'failed' })
    }
    let text: string
    try {
      text = await response.text()
    } catch {
      if (mine === token) show({ kind: 'failed' })
      return
    }
    if (mine !== token || !state) return
    const decoded = decodeMessages(text)
    if (!decoded.ok) {
      show({ kind: 'failed' })
      return
    }
    const { response: body } = decoded
    // Discarded unread: a newer status already asked again, or access ended.
    if (!bindMessages(body, { openSession: state.session, lastStatus })) return
    abort = null
    policyRetried = false
    busyRetried = false
    show(
      body.result.state === 'messages'
        ? { kind: 'messages', entries: body.result.entries, older: body.result.older }
        : { kind: 'unavailable', reason: body.result.reason }
    )
  }

  function refused(code: RemoteErrorCode | null): void {
    abort = null
    switch (code) {
      case 'details-off':
        return show({ kind: 'not-shared' })
      case 'not-found':
        return show({ kind: 'unavailable', reason: 'gone' })
      case 'policy-changed':
        if (policyRetried) return show({ kind: 'failed' })
        policyRetried = true
        retryOnStatus = true
        return show({ kind: 'loading' })
      case 'busy':
        if (busyRetried) return show({ kind: 'failed' })
        busyRetried = true
        show({ kind: 'loading' })
        timer = setTimer(() => {
          timer = undefined
          request()
        }, REMOTE_LIMITS.retryAfterSeconds * 1000)
        return
      case 'not-allowed':
      case 'bad-host':
      case 'bad-origin':
      case 'unsupported-version':
        // Access itself ended; the stream says so on its own. Nothing of the detail stays.
        return close()
      default:
        return show({ kind: 'failed' })
    }
  }

  function close(): void {
    cancel()
    askedGeneration = -1
    lastActivityAt = null
    if (state) set(null)
  }

  /** At most one new request every `detailRefreshMs` while the session changes. */
  function refreshSoon(): void {
    if (timer !== undefined) return
    const wait = lastRequestAt + REMOTE_LIMITS.detailRefreshMs - now()
    if (wait <= 0) return request(true)
    timer = setTimer(() => {
      timer = undefined
      request(true)
    }, wait)
  }

  return {
    open(session) {
      if (state?.session === session) return
      cancel()
      policyRetried = false
      busyRetried = false
      lastRequestAt = -Infinity
      set({ session, view: { kind: 'loading' } })
      if (!lastStatus) return show({ kind: 'paused' })
      if (!lastStatus.details) return show({ kind: 'not-shared' })
      if (!detailsAllowed(lastStatus, session)) return show({ kind: 'unavailable', reason: 'gone' })
      request()
    },
    close,
    status(frame) {
      if (frame === lastStatus) return
      lastStatus = frame
      if (!state) return
      const { session, view } = state
      if (!frame.details) {
        cancel()
        return show({ kind: 'not-shared' })
      }
      const row = rowOf(frame, session)
      if (!row) {
        cancel()
        return show({ kind: 'unavailable', reason: 'gone' })
      }
      if (frame.generation > askedGeneration) {
        // A new sharing policy: what was shown was allowed under the old one only.
        return request()
      }
      if (retryOnStatus) {
        retryOnStatus = false
        return request()
      }
      if (view.kind === 'not-shared' || view.kind === 'paused') return request()
      if (view.kind === 'unavailable' && view.reason === 'gone') return
      if (row.lastActivityAt !== lastActivityAt) refreshSoon()
    },
    pause() {
      lastStatus = null
      cancel()
      askedGeneration = -1
      if (state && state.view.kind !== 'paused') show({ kind: 'paused' })
    },
    retry() {
      if (!state || state.view.kind !== 'failed') return
      policyRetried = false
      busyRetried = false
      request()
    }
  }
}
