import { describe, expect, it, vi } from 'vitest'
import { createSessionsStore, displayedGroups } from './sessions-store'
import { fakeApi, NOW, session, snapshot } from '../test-support'
import { buildView } from '../../core/views'

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
    expect(fake.api.onCommand).toHaveBeenCalledOnce()
    offSecond()
    expect(fake.offSnapshot).not.toHaveBeenCalled()
    off()
    await Promise.resolve()
    expect(listener).not.toHaveBeenCalled()
    expect(store.getSnapshot().snapshot).toBeNull()
    expect(fake.offSnapshot).toHaveBeenCalledOnce()
    expect(fake.offCommand).toHaveBeenCalledOnce()
    fake.push(snapshot([session('after-unmount')]))
    expect(store.getSnapshot().snapshot).toBeNull()
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
    expect(store.getSnapshot().selection?.session.key).toEqual(b.key)
    expect(displayedGroups(store.getSnapshot())).toEqual([])
    off()
  })
})

describe('two detail slots', () => {
  async function setup() {
    const a = session('a')
    const b = session('b', { key: { tool: 'claude', id: 'b' } })
    const c = session('c')
    const fake = fakeApi(snapshot([a, b, c]))
    const store = createSessionsStore(fake.api)
    store.setGrouping('status')
    const off = store.subscribe(vi.fn())
    await Promise.resolve()
    const select = (s: typeof a) => store.select(s, displayedGroups(store.getSnapshot()))
    return { ...fake, store, off, a, b, c, select }
  }

  it('routes object commands without selecting their row, and never targets an unmounted Second', async () => {
    const f = await setup()
    f.select(f.a)
    f.command({ type: 'open-secondary', key: f.b.key })
    expect(f.store.getSnapshot().selection?.session.key).toEqual(f.a.key)
    expect(f.api.setSelection).toHaveBeenLastCalledWith(null, { secondPaneOpen: true })
    f.store.setVisiblePanes(['main', 'second'])
    expect(f.api.setSelection).toHaveBeenLastCalledWith(f.b.key, { secondPaneOpen: true })
    await Promise.resolve()
    const generation = f.store.getSnapshot().targetGeneration
    expect(f.store.canAutoRead('second', f.b.key, generation)).toBe(true)
    expect(f.store.canAutoRead('main', f.a.key, generation)).toBe(false)
    f.command({ type: 'close-secondary' })
    expect(f.api.setSelection).toHaveBeenLastCalledWith(f.a.key, { secondPaneOpen: false })
    f.off()
  })

  it('ignores delayed/rejected activations and rechecks same-key pane generations', async () => {
    const f = await setup()
    const pending: { resolve: () => void; reject: () => void }[] = []
    f.api.setSelection.mockImplementation(
      () =>
        new Promise<void>((resolve, reject) => {
          pending.push({ resolve, reject: () => reject(new Error('synthetic')) })
        })
    )
    f.select(f.a)
    const first = f.store.getSnapshot().targetGeneration
    expect(f.store.canAutoRead('main', f.a.key, first)).toBe(false)
    f.select(f.c)
    const second = f.store.getSnapshot().targetGeneration
    pending[1]!.resolve()
    await Promise.resolve()
    expect(f.store.canAutoRead('main', f.c.key, second)).toBe(true)
    pending[0]!.reject()
    await Promise.resolve()
    expect(f.store.getSnapshot().actionError).toBeNull()
    expect(f.store.canAutoRead('main', f.a.key, first)).toBe(false)
    f.store.setVisiblePanes(['main', 'second'])
    f.store.openSecondary(f.c.key)
    const third = f.store.getSnapshot().targetGeneration
    pending.at(-1)!.resolve()
    await Promise.resolve()
    expect(f.store.canAutoRead('second', f.c.key, third)).toBe(true)
    expect(f.store.canAutoRead('main', f.c.key, second)).toBe(false)
    f.store.activatePane('main')
    pending.at(-1)!.reject()
    await Promise.resolve()
    expect(f.store.getSnapshot().targetReady).toBe(false)
    f.select(f.c) // A fresh explicit activation can retry the failed synchronization.
    pending.at(-1)!.resolve()
    await Promise.resolve()
    expect(f.store.getSnapshot().targetReady).toBe(true)
    f.off()
  })

  it('clears only the active target on source loss/browse and restores it on rediscovery', async () => {
    const f = await setup()
    f.store.setVisiblePanes(['main', 'second'])
    f.select(f.a)
    f.store.openSecondary(f.b.key)
    f.push(snapshot([f.a, f.c]))
    expect(f.api.setSelection).toHaveBeenLastCalledWith(null, { secondPaneOpen: true })
    expect(f.store.getSnapshot().targetReady).toBe(false)
    f.push(snapshot([f.a, f.b, f.c]))
    expect(f.api.setSelection).toHaveBeenLastCalledWith(f.b.key, { secondPaneOpen: true })
    f.store.setNarrow(true)
    f.store.back()
    expect(f.api.setSelection).toHaveBeenLastCalledWith(null, { secondPaneOpen: true })
    expect(f.api.setDetailOpen).toHaveBeenLastCalledWith(false)
    f.off()
  })

  it('routes ordinary activation to either active pane and explicit placement preserves its sibling', async () => {
    const f = await setup()
    f.select(f.a)
    const main = f.store.getSnapshot().selection
    f.store.openSecondary(f.b.key)
    f.store.activate(f.c, displayedGroups(f.store.getSnapshot()))
    expect(f.store.getSnapshot()).toMatchObject({
      selection: main,
      secondarySelection: { session: f.c },
      activePane: 'second'
    })
    const second = f.store.getSnapshot().secondarySelection
    f.command({ type: 'open-primary', key: f.b.key })
    expect(f.store.getSnapshot().secondarySelection).toBe(second)
    expect(f.store.getSnapshot().activePane).toBe('main')
    f.store.activate(f.a, displayedGroups(f.store.getSnapshot()))
    expect(f.store.getSnapshot().selection?.session).toBe(f.a)
    expect(f.store.getSnapshot().secondarySelection).toBe(second)
    f.store.closeSecondary()
    expect(f.store.getSnapshot()).toMatchObject({ secondarySelection: null, activePane: 'main' })
    expect(f.api.onSnapshot).toHaveBeenCalledOnce()
    expect(f.api.onCommand).toHaveBeenCalledOnce()
    f.off()
  })

  it('keeps same-key slots separate while sharing current session truth and one list anchor', async () => {
    const f = await setup()
    f.select(f.a)
    f.store.openSecondary(f.a.key)
    expect(f.store.getSnapshot().selection).not.toBe(f.store.getSnapshot().secondarySelection)
    const second = f.store.getSnapshot().secondarySelection
    f.store.activatePane('main')
    f.select(f.c)
    f.store.openSecondary(f.a.key)
    expect(f.store.getSnapshot().secondarySelection).toBe(second)
    expect(f.store.getSnapshot().activePane).toBe('second')
    f.store.activatePane('main')
    f.select(f.a)
    const updated = { ...f.a, pinned: true, activity: { state: 'idle' } as const }
    f.push(snapshot([updated, f.b, f.c], { takenAt: NOW + 1 }))
    const state = f.store.getSnapshot()
    expect(state.selection?.session).toEqual(updated)
    expect(state.secondarySelection?.session).toBe(state.selection?.session)
    expect(state.selection).not.toBe(state.secondarySelection)
    expect(
      displayedGroups(state)
        .flatMap((g) => g.sessions)
        .filter((s) => s.key.id === 'a')
    ).toHaveLength(1)
    expect(buildView(state.snapshot!.sessions, state.view, state.filter).toolCounts).toEqual({
      all: 2,
      codex: 1,
      claude: 1
    })
    f.off()
  })

  it('preserves both panes on view/filter changes and clears the list cursor without inserting it into the list', async () => {
    const f = await setup()
    f.select(f.a)
    f.store.openSecondary(f.b.key)
    const second = f.store.getSnapshot().secondarySelection
    f.store.setFilter('codex')
    expect(f.store.getSnapshot()).toMatchObject({
      selection: { session: f.a },
      listSelection: null,
      activePane: 'second'
    })
    expect(f.store.getSnapshot().secondarySelection).toBe(second)
    expect(displayedGroups(f.store.getSnapshot()).flatMap((g) => g.sessions)).toEqual([f.a, f.c])
    f.store.showSessions()
    f.command('view:pinned')
    expect(f.store.getSnapshot()).toMatchObject({
      selection: { session: f.a },
      listSelection: null,
      activePane: 'second'
    })
    expect(f.store.getSnapshot().secondarySelection).toBe(second)
    expect(displayedGroups(f.store.getSnapshot())).toEqual([])
    const updated = { ...f.b, pinned: true }
    f.push(snapshot([f.a, updated, f.c], { takenAt: NOW + 10 }))
    expect(f.store.getSnapshot().secondarySelection).toMatchObject({
      session: updated,
      lastSeenAt: NOW + 10,
      sourceEpoch: 0
    })
    expect(f.store.getSnapshot().activePane).toBe('second')
    expect(displayedGroups(f.store.getSnapshot())).toEqual([])
    f.off()
  })

  it('does not reinsert filtered pane rows on return, focus or explicit same-key placement', async () => {
    const f = await setup()
    f.select(f.a)
    f.store.openSecondary(f.a.key)
    f.store.setFilter('claude')
    const ids = () =>
      displayedGroups(f.store.getSnapshot()).flatMap((g) => g.sessions.map((s) => s.key.id))
    expect(ids()).toEqual(['b'])
    f.store.returnToSessions()
    expect(ids()).toEqual(['b'])
    f.store.activatePane('main')
    expect(ids()).toEqual(['b'])
    f.store.openSecondary(f.a.key)
    expect(ids()).toEqual(['b'])
    f.off()
  })

  it.each(['return', 'activate', 'focus', 'explicit'] as const)(
    'uses the current view group for a new list cursor after %s',
    async (entry) => {
      const f = await setup()
      f.select(f.a)
      f.store.openSecondary(f.a.key)
      f.store.setView('all')
      if (entry === 'return') f.store.returnToSessions()
      if (entry === 'activate') f.store.activate(f.a, displayedGroups(f.store.getSnapshot()))
      if (entry === 'focus') f.store.activatePane('second')
      if (entry === 'explicit') f.store.openSecondary(f.a.key)
      const groups = displayedGroups(f.store.getSnapshot())
      expect(groups.map((g) => g.id)).toEqual(['all'])
      expect(groups[0]!.sessions.filter((s) => s.key.id === 'a')).toHaveLength(1)
      f.off()
    }
  )

  it.each(['main', 'second'] as const)(
    'freezes only a missing %s source and independently restarts its provenance',
    async (pane) => {
      const f = await setup()
      f.select(f.a)
      f.store.openSecondary(f.b.key)
      const [missing, healthy] = pane === 'main' ? [f.a, f.b] : [f.b, f.a]
      const field = pane === 'main' ? 'selection' : 'secondarySelection'
      const otherField = pane === 'main' ? 'secondarySelection' : 'selection'
      f.push(snapshot([healthy, f.c], { takenAt: NOW + 10 }))
      f.push(snapshot([healthy, f.c], { takenAt: NOW + 20 }))
      expect(f.store.getSnapshot()[field]).toMatchObject({
        session: missing,
        lastSeenAt: NOW,
        sourceEpoch: 1
      })
      expect(f.store.getSnapshot()[otherField]).toMatchObject({
        session: healthy,
        lastSeenAt: NOW + 20,
        sourceEpoch: 0
      })
      expect(f.store.getSnapshot().activePane).toBe('second')
      const recovered = { ...missing, pinned: true }
      f.push(snapshot([healthy, recovered, f.c], { takenAt: NOW + 30 }))
      expect(f.store.getSnapshot()[field]).toMatchObject({
        session: recovered,
        lastSeenAt: NOW + 30,
        sourceEpoch: 2
      })
      expect(f.store.getSnapshot()[otherField]?.sourceEpoch).toBe(0)
      expect(f.store.getSnapshot().activePane).toBe('second')
      f.off()
    }
  )

  it('does not restore a replaced or closed Second when an older reload completes', async () => {
    const f = await setup()
    f.select(f.a)
    f.store.openSecondary(f.b.key)
    f.push(snapshot([f.a, f.c], { takenAt: NOW + 10 }))
    let finish!: () => void
    f.api.reload.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const reload = f.store.reload()
    await f.store.reload()
    expect(f.api.reload).toHaveBeenCalledOnce()
    f.store.openSecondary(f.c.key)
    const replacement = f.store.getSnapshot().secondarySelection
    finish()
    await reload
    expect(f.store.getSnapshot().secondarySelection).toBe(replacement)
    f.store.closeSecondary()
    f.push(snapshot([f.a, f.b, f.c], { takenAt: NOW + 20 }))
    expect(f.store.getSnapshot().secondarySelection).toBeNull()
    expect(f.store.getSnapshot().selection?.session).toEqual(f.a)
    expect(f.store.getSnapshot().reloadPending).toBe(false)
    f.off()
  })

  it('retains both slots through narrow browsing and resize without a hidden active pane', async () => {
    const f = await setup()
    f.store.setNarrow(true)
    f.select(f.a)
    expect(f.store.getSnapshot().activePane).toBeNull()
    f.store.openSecondary(f.b.key)
    expect(f.store.getSnapshot()).toMatchObject({ activePane: 'second', detailOpen: true })
    f.store.back()
    expect(f.store.getSnapshot()).toMatchObject({ activePane: null, detailOpen: false })
    f.store.setNarrow(false)
    expect(f.store.getSnapshot()).toMatchObject({ activePane: null, detailOpen: false })
    f.select(f.c)
    expect(f.store.getSnapshot()).toMatchObject({ activePane: null, detailOpen: false })
    f.store.activate(f.c, displayedGroups(f.store.getSnapshot()))
    expect(f.store.getSnapshot().activePane).toBe('second')
    f.store.setNarrow(true)
    expect(f.store.getSnapshot()).toMatchObject({ activePane: 'second', detailOpen: true })
    f.store.back()
    f.select(f.a)
    expect(f.store.getSnapshot().activePane).toBeNull()
    f.store.activate(f.c, displayedGroups(f.store.getSnapshot()))
    expect(f.store.getSnapshot()).toMatchObject({ activePane: 'second', detailOpen: true })
    f.store.closeSecondary()
    expect(f.store.getSnapshot()).toMatchObject({ activePane: 'main', detailOpen: true })
    f.store.openSecondary(f.b.key)
    f.store.back()
    f.store.setNarrow(false)
    expect(f.store.getSnapshot().activePane).toBeNull()
    f.store.closeSecondary()
    expect(f.store.getSnapshot()).toMatchObject({
      activePane: 'main',
      secondarySelection: null,
      detailOpen: false
    })
    f.off()
  })

  it('ignores absent keys and closes a secondary-only layout to the empty main state', async () => {
    const f = await setup()
    f.store.openSecondary({ tool: 'codex', id: 'missing' })
    f.store.activatePane('second')
    expect(f.store.getSnapshot()).toMatchObject({ secondarySelection: null, activePane: null })
    f.store.setNarrow(true)
    f.store.openSecondary(f.b.key)
    f.store.activatePane('main')
    expect(f.store.getSnapshot().activePane).toBe('second')
    f.store.closeSecondary()
    expect(f.store.getSnapshot()).toMatchObject({
      selection: null,
      secondarySelection: null,
      activePane: null,
      detailOpen: false
    })
    f.off()
  })
})
