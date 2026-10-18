import { describe, expect, it, vi } from 'vitest'
import { createSessionsStore, displayedGroups } from './sessions-store'
import { fakeApi, session, snapshot } from '../test-support'

describe('renderer subscription lifetime', () => {
  it('ignores a stale initial request after a pushed snapshot', async () => {
    const fake = fakeApi()
    let resolve!: (s: ReturnType<typeof snapshot>) => void
    fake.api.getSnapshot.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    const store = createSessionsStore(fake.api)
    const off = store.subscribe(vi.fn())
    fake.push(snapshot([session('live')]))
    resolve(snapshot([session('stale')]))
    await Promise.resolve()
    expect(store.getSnapshot().snapshot?.sessions[0]?.key.id).toBe('live')
    off()
  })

  it('shares listeners, cleans up both channels, and cancels unmounted request results', async () => {
    const fake = fakeApi()
    const store = createSessionsStore(fake.api)
    const listener = vi.fn()
    const off = store.subscribe(listener)
    const offSecond = store.subscribe(vi.fn())
    expect(fake.api.onSnapshot).toHaveBeenCalledOnce()
    offSecond()
    expect(fake.offSnapshot).not.toHaveBeenCalled()
    off()
    await Promise.resolve()
    expect(listener).not.toHaveBeenCalled()
    expect(store.getSnapshot().snapshot).toBeNull()
    expect(fake.offCommand).toHaveBeenCalledOnce()
  })

  it('recovers from initial failure through a later pushed snapshot', async () => {
    const fake = fakeApi()
    fake.api.getSnapshot.mockRejectedValue(new Error('synthetic failure'))
    const store = createSessionsStore(fake.api)
    const off = store.subscribe(vi.fn())
    await Promise.resolve()
    await Promise.resolve()
    expect(store.getSnapshot().failed).toBe(true)
    fake.push(snapshot([session('a')]))
    expect(store.getSnapshot().failed).toBe(false)
    off()
  })

  it('keeps the selected slot across new sort order, then releases it on the next selection', async () => {
    const a = session('a')
    const b = session('b')
    const fake = fakeApi(snapshot([a, b]))
    const store = createSessionsStore(fake.api)
    const off = store.subscribe(vi.fn())
    await Promise.resolve()
    store.select(a, displayedGroups(store.getSnapshot()))
    fake.push(snapshot([b, { ...a, pinned: true }, session('new', { pinned: true })]))
    expect(displayedGroups(store.getSnapshot())[0]?.sessions[0]?.key.id).toBe('a')
    store.select(b, displayedGroups(store.getSnapshot()))
    expect(displayedGroups(store.getSnapshot())[0]?.sessions.map((s) => s.key.id)).toEqual([
      'a',
      'new',
      'b'
    ])
    store.setFilter('claude')
    expect(store.getSnapshot().selection).toBeNull()
    expect(displayedGroups(store.getSnapshot())).toEqual([])
    off()
  })
})
