import { createHmac } from 'node:crypto'
import type { SessionIdMinter } from '../../core/remote/status-projection'
import { sessionKeyToString } from '../../core/session'

/** The shortest per-viewer secret accepted, in bytes. */
export const MIN_SESSION_ID_SECRET_BYTES = 32

/**
 * Opaque Remote View session IDs: HMAC-SHA256 of the session key under a Mac-local secret, cut to
 * 128 bits and base64url-encoded. The same secret always gives the same ID; another secret gives
 * unrelated IDs, so rotating it makes old IDs meaningless. TASK-014 stores or derives the secret.
 */
export function createSessionIdMinter(secret: Uint8Array): SessionIdMinter {
  if (secret.byteLength < MIN_SESSION_ID_SECRET_BYTES) {
    throw new Error('Remote View session ID secret is too short')
  }
  const key = Buffer.from(secret)
  return (sessionKey) =>
    createHmac('sha256', key)
      .update(sessionKeyToString(sessionKey))
      .digest()
      .subarray(0, 16)
      .toString('base64url')
}
