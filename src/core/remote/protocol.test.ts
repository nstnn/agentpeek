import { describe, expect, it } from 'vitest'
import {
  bindMessages,
  checkRemoteRequest,
  decodeFrame,
  decodeMessages,
  detailsAllowed,
  encodeFrame,
  errorBody,
  isTailnetHostName,
  macNow,
  reconnectDelayMs,
  REMOTE_ERROR_STATUS,
  REMOTE_LIMITS,
  REMOTE_ROUTES,
  type StatusFrame
} from './protocol'
import {
  DECODE_VECTORS,
  MESSAGES_DECODE_VECTORS,
  NARROWED_STATUS_FRAME,
  OWNER_HEADERS,
  REQUEST_VECTORS,
  VALID_MESSAGES_RESPONSE,
  VALID_STATUS_FRAME,
  VECTOR_CONFIG
} from './protocol-vectors'
import type { RemoteSession } from './status-projection'

describe('checkRemoteRequest vectors', () => {
  for (const vector of REQUEST_VECTORS) {
    it(vector.name, () => {
      const decision = checkRemoteRequest(vector.request, VECTOR_CONFIG)
      expect(decision.ok ? decision.route.route : decision.error).toBe(vector.expected)
    })
  }

  it('lets nobody in while the owner login or host name is not configured', () => {
    const request = { method: 'GET', target: '/', headers: OWNER_HEADERS }
    expect(checkRemoteRequest(request, { ...VECTOR_CONFIG, ownerLogin: '' })).toEqual({
      ok: false,
      error: 'not-allowed'
    })
    expect(checkRemoteRequest(request, { ...VECTOR_CONFIG, hostName: '127.0.0.1' })).toEqual({
      ok: false,
      error: 'bad-host'
    })
  })

  it('accepts only <device>.<tailnet>.ts.net host names', () => {
    expect(isTailnetHostName('synthetic-mac.tail0000.ts.net')).toBe(true)
    for (const name of [
      'tail0000.ts.net',
      'a.b.tail0000.ts.net',
      'Synthetic.tail0000.ts.net',
      'mac.tail0000.ts.net:443',
      '-mac.tail0000.ts.net',
      'mac.tail0000.ts.net.evil.example',
      'localhost'
    ]) {
      expect(isTailnetHostName(name), name).toBe(false)
    }
  })

  it('writes error bodies with the code only', () => {
    expect(JSON.parse(errorBody('not-allowed'))).toEqual({ v: 2, error: 'not-allowed' })
  })
})

describe('decodeFrame vectors', () => {
  for (const vector of DECODE_VECTORS) {
    it(vector.name, () => {
      const result = decodeFrame(vector.event, vector.data)
      expect(result.ok ? 'ok' : result.error).toBe(vector.expected)
    })
  }

  it('round-trips what encodeFrame writes', () => {
    const encoded = encodeFrame(VALID_STATUS_FRAME)
    expect(encoded.ok).toBe(true)
    if (!encoded.ok) return
    const [eventLine, dataLine, ...rest] = encoded.event.split('\n')
    expect(eventLine).toBe('event: status')
    expect(rest).toEqual(['', ''])
    const decoded = decodeFrame('status', dataLine!.slice('data: '.length))
    expect(decoded).toEqual({ ok: true, frame: VALID_STATUS_FRAME })
  })

  it('replaces the whole status on a narrowed policy', () => {
    const decoded = decodeFrame('status', JSON.stringify(NARROWED_STATUS_FRAME))
    expect(decoded.ok && decoded.frame.type === 'status' && decoded.frame.status.projects).toEqual(
      []
    )
    expect(NARROWED_STATUS_FRAME.generation).toBeGreaterThan(VALID_STATUS_FRAME.generation)
  })
})

describe('encodeFrame budget', () => {
  /** 250 rows whose titles use four UTF-8 bytes per code point, well over 192 KiB in all. */
  function hugeFrame(): StatusFrame {
    const title = '𝒜'.repeat(160)
    const sessions: RemoteSession[] = Array.from({ length: 250 }, (_, index) => ({
      id: `${String(index).padStart(3, '0')}${'A'.repeat(19)}`,
      tool: 'codex',
      title,
      activity: { state: 'idle' },
      attention: { waiting: false, newReply: false, error: false },
      attentionSince: null,
      lastActivityAt: 1_000_000 + index
    }))
    return {
      ...VALID_STATUS_FRAME,
      status: {
        ...VALID_STATUS_FRAME.status,
        projects: [{ label: 'synthetic-project', sessions }],
        omitted: { projects: 0, sessions: 2 }
      }
    }
  }

  it('keeps the newest rows that fit and counts the rest as omitted', () => {
    const encoded = encodeFrame(hugeFrame())
    expect(encoded.ok).toBe(true)
    if (!encoded.ok || encoded.frame.type !== 'status') return
    const data = encoded.event.split('\n')[1]!.slice('data: '.length)
    expect(new TextEncoder().encode(data).length).toBeLessThanOrEqual(REMOTE_LIMITS.maxFrameBytes)
    const rows = encoded.frame.status.projects[0]!.sessions
    expect(rows.length).toBeGreaterThan(100)
    expect(rows.length).toBeLessThan(250)
    // Newest first: the kept rows are the highest lastActivityAt values.
    expect(Math.min(...rows.map((row) => row.lastActivityAt))).toBe(1_000_000 + 250 - rows.length)
    expect(encoded.frame.status.omitted.sessions).toBe(2 + 250 - rows.length)
    expect(decodeFrame('status', data).ok).toBe(true)
  })

  it('is deterministic', () => {
    expect(encodeFrame(hugeFrame())).toEqual(encodeFrame(hugeFrame()))
  })

  it('writes heartbeat and end frames as single events', () => {
    const end = encodeFrame({ v: 2, type: 'end', reason: 'shutdown' })
    expect(end).toMatchObject({
      ok: true,
      event: 'event: end\ndata: {"v":2,"type":"end","reason":"shutdown"}\n\n'
    })
  })
})

describe('viewer timing', () => {
  it('reconnects with full jitter capped at 30 s', () => {
    expect(reconnectDelayMs(0, () => 0.999)).toBe(999)
    expect(reconnectDelayMs(3, () => 0.5)).toBe(4_000)
    expect(reconnectDelayMs(40, () => 0.999_999)).toBeLessThan(REMOTE_LIMITS.reconnectMaxMs)
    expect(reconnectDelayMs(40, () => 0)).toBe(0)
  })

  it('estimates the Mac clock from the last frame, not the viewer’s wall clock', () => {
    // The viewer's clock is five minutes off; only the elapsed local time counts.
    expect(macNow(1_800_000_004_000, 50_000, 53_000)).toBe(1_800_000_007_000)
    expect(macNow(1_800_000_004_000, 50_000, 49_000)).toBe(1_800_000_004_000)
  })

  it('needs three missed heartbeats before the stream counts as lost', () => {
    expect(REMOTE_LIMITS.silenceLimitMs).toBe(3 * REMOTE_LIMITS.heartbeatIntervalMs)
  })
})

describe('recent messages (protocol v2)', () => {
  for (const vector of MESSAGES_DECODE_VECTORS) {
    it(`decodes: ${vector.name}`, () => {
      const decoded = decodeMessages(vector.data)
      expect(decoded.ok ? 'ok' : decoded.error).toBe(vector.expected)
    })
  }

  it('names the route by the opaque ID', () => {
    expect(REMOTE_ROUTES.messages(VALID_MESSAGES_RESPONSE.session)).toBe(
      `/v2/sessions/${VALID_MESSAGES_RESPONSE.session}/messages`
    )
  })

  it('writes the new error codes with the HTTP statuses of the contract', () => {
    expect(REMOTE_ERROR_STATUS['details-off']).toBe(403)
    expect(REMOTE_ERROR_STATUS['policy-changed']).toBe(409)
    expect(REMOTE_ERROR_STATUS['not-found']).toBe(404)
    expect(REMOTE_ERROR_STATUS.busy).toBe(503)
    expect(JSON.parse(errorBody('details-off'))).toEqual({ v: 2, error: 'details-off' })
  })

  describe('binding', () => {
    const shared: StatusFrame = { ...VALID_STATUS_FRAME, details: true }
    const open = VALID_MESSAGES_RESPONSE.session

    it('accepts a response for the open session under the current generation', () => {
      expect(bindMessages(VALID_MESSAGES_RESPONSE, { openSession: open, lastStatus: shared })).toBe(
        true
      )
      const newer = { ...VALID_MESSAGES_RESPONSE, generation: shared.generation + 1 }
      expect(bindMessages(newer, { openSession: open, lastStatus: shared })).toBe(true)
    })

    it('discards a response for another session', () => {
      const other = { ...VALID_MESSAGES_RESPONSE, session: 'BBBBBBBBBBBBBBBBBBBBBB' }
      expect(bindMessages(other, { openSession: open, lastStatus: shared })).toBe(false)
      expect(bindMessages(VALID_MESSAGES_RESPONSE, { openSession: null, lastStatus: shared })).toBe(
        false
      )
    })

    it('discards a response with a lower generation', () => {
      const older = { ...VALID_MESSAGES_RESPONSE, generation: shared.generation - 1 }
      expect(bindMessages(older, { openSession: open, lastStatus: shared })).toBe(false)
    })

    it('discards a response once the status stops sharing details or listing the session', () => {
      expect(
        bindMessages(VALID_MESSAGES_RESPONSE, { openSession: open, lastStatus: VALID_STATUS_FRAME })
      ).toBe(false)
      const removed = { ...NARROWED_STATUS_FRAME, details: true, generation: shared.generation }
      expect(
        bindMessages(VALID_MESSAGES_RESPONSE, { openSession: open, lastStatus: removed })
      ).toBe(false)
      expect(bindMessages(VALID_MESSAGES_RESPONSE, { openSession: open, lastStatus: null })).toBe(
        false
      )
    })

    it('clears an open detail on a status with details: false or without the session', () => {
      expect(detailsAllowed(shared, open)).toBe(true)
      expect(detailsAllowed(VALID_STATUS_FRAME, open)).toBe(false)
      expect(detailsAllowed({ ...NARROWED_STATUS_FRAME, details: true }, open)).toBe(false)
    })
  })
})
