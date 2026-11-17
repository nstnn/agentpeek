import { describe, expect, it } from 'vitest'
import { createSessionIdMinter } from './session-ids'

// Synthetic secrets and keys only.
const SECRET_A = new Uint8Array(32).fill(1)
const SECRET_B = new Uint8Array(32).fill(2)

describe('createSessionIdMinter', () => {
  it('gives the same opaque ID for the same key and secret', () => {
    const mint = createSessionIdMinter(SECRET_A)
    const id = mint({ tool: 'codex', id: 'raw-thread-1' })
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(createSessionIdMinter(SECRET_A)({ tool: 'codex', id: 'raw-thread-1' })).toBe(id)
    expect(id).not.toContain('raw-thread-1')
  })

  it('separates tools and changes every ID when the secret rotates', () => {
    const mintA = createSessionIdMinter(SECRET_A)
    const mintB = createSessionIdMinter(SECRET_B)
    const key = { tool: 'claude', id: 'same' } as const
    expect(mintA(key)).not.toBe(mintA({ tool: 'codex', id: 'same' }))
    expect(mintA(key)).not.toBe(mintB(key))
  })

  it('refuses a short secret', () => {
    expect(() => createSessionIdMinter(new Uint8Array(16))).toThrow(/too short/)
  })

  it('is unaffected by later changes to the caller’s secret buffer', () => {
    const secret = new Uint8Array(32).fill(3)
    const mint = createSessionIdMinter(secret)
    const before = mint({ tool: 'codex', id: 'x' })
    secret.fill(4)
    expect(mint({ tool: 'codex', id: 'x' })).toBe(before)
  })
})
