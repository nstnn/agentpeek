import { describe, expect, it, vi } from 'vitest'
import { createSessionController } from './session-controller'
import { testService, testSession, testSystem } from './test-support'

function setup() {
  const service = testService()
  const system = testSystem()
  const options = {
    service,
    system,
    fixtureHome: '/synthetic/home',
    reload: service.reconcile,
    command: vi.fn(),
    updateMenu: vi.fn(),
    popup: vi.fn()
  }
  return { ...options, controller: createSessionController(options) }
}

describe('session controller', () => {
  it('rejects automatic acknowledgement if native focus was lost before IPC arrived', () => {
    const s = setup()
    const current = testSession({
      lastReply: {
        cursor: 'reply',
        isError: true,
        completedAt: 1,
        errorCode: 'synthetic',
        newerTurnStarted: false
      }
    })
    s.service.snapshot.mockReturnValue({ ...s.service.snapshot(), sessions: [current] })
    const controller = createSessionController({ ...s, isFocused: () => false })
    expect(controller.markRead(current.key, 'reply')).toBe(false)
    expect(s.service.markRead).not.toHaveBeenCalled()
    controller.markRead(current.key)
    expect(s.service.markRead).toHaveBeenCalledWith(current.key)
  })
  it('enables Back only for an actual narrow detail and keeps Back usable after the session disappears', () => {
    const s = setup()
    const isNarrow = vi.fn(() => false)
    const controller = createSessionController({ ...s, isNarrow })
    controller.setSelection(testSession().key)
    controller.setDetailOpen(true)
    expect(controller.canGoBack()).toBe(false)
    isNarrow.mockReturnValue(true)
    expect(controller.canGoBack()).toBe(false)
    controller.setDetailOpen(true)
    expect(controller.canGoBack()).toBe(true)
    s.service.snapshot.mockReturnValue({ ...s.service.snapshot(), sessions: [] })
    controller.publish()
    expect(controller.canGoBack()).toBe(true)
    controller.setDetailOpen(false)
    expect(controller.canGoBack()).toBe(false)
  })
  it('does not acknowledge a newer reply than the detail actually displayed', () => {
    const s = setup()
    const current = testSession({
      lastReply: {
        cursor: 'new',
        isError: false,
        completedAt: 1,
        errorCode: null,
        newerTurnStarted: false
      }
    })
    s.service.snapshot.mockReturnValue({ ...s.service.snapshot(), sessions: [current] })
    expect(s.controller.markRead(current.key, 'old')).toBe(false)
    expect(s.service.markRead).not.toHaveBeenCalled()
    s.controller.markRead(current.key, 'new')
    expect(s.service.markRead).toHaveBeenCalledWith(current.key)
  })
  it('exposes the fixture path without adding messages to the snapshot', () => {
    const { controller } = setup()
    expect(controller.snapshot()).toMatchObject({ fixture: true, fixtureHome: '/synthetic/home' })
    expect(controller.snapshot()).not.toHaveProperty('messages')
  })
  it('starts unselected, selects listed keys only, and clears a disappeared selection', () => {
    const { controller, service } = setup()
    expect(controller.selected()).toBeNull()
    controller.setSelection(testSession().key)
    expect(controller.selected()?.key).toEqual(testSession().key)
    service.snapshot.mockReturnValue({ ...service.snapshot(), sessions: [] })
    controller.publish()
    expect(controller.selected()).toBeNull()
    controller.setSelection(testSession().key)
    expect(controller.selected()).toBeNull()
  })
  it('rechecks menu targets against the latest snapshot before acting', () => {
    const { controller, service, system } = setup()
    controller.setSelection(testSession().key)
    const actions = controller.actions()
    service.snapshot.mockReturnValue({ ...service.snapshot(), sessions: [] })
    actions.pin()
    actions.markRead()
    actions.copy()
    actions.open()
    expect(service.setPinned).not.toHaveBeenCalled()
    expect(service.markRead).not.toHaveBeenCalled()
    expect(system.copyText).not.toHaveBeenCalled()
    expect(system.openTool).not.toHaveBeenCalled()
  })
  it('pins the latest state and copies only the listed tool session ID', async () => {
    const { controller, service, system } = setup()
    controller.setSelection(testSession().key)
    controller.actions().pin()
    expect(service.setPinned).toHaveBeenCalledWith(testSession().key, true)
    service.snapshot.mockReturnValue({
      ...service.snapshot(),
      sessions: [testSession({ pinned: true })]
    })
    controller.actions().pin()
    expect(service.setPinned).toHaveBeenLastCalledWith(testSession().key, false)
    expect(await controller.copySessionId(testSession().key)).toBe(true)
    expect(system.copyText).toHaveBeenCalledWith('synthetic-session')
    expect(await controller.copySessionId({ tool: 'codex', id: 'absent' })).toBe(false)
  })
  it('does not read messages or open a context menu for an unlisted key', async () => {
    const { controller, service, popup } = setup()
    const key = { tool: 'codex', id: 'absent' } as const
    expect(await controller.getMessages(key, 10)).toEqual({ kind: 'not-found' })
    await controller.showSessionMenu(key)
    expect(service.recentMessages).not.toHaveBeenCalled()
    expect(popup).not.toHaveBeenCalled()
    await controller.showSessionMenu(testSession().key)
    expect(popup).toHaveBeenCalledOnce()
    expect(popup.mock.calls[0]?.[0]).toHaveLength(4)
  })
  it('keeps the context invocation pending until the native popup is dismissed', async () => {
    const { controller, popup } = setup()
    let dismiss!: () => void
    popup.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          dismiss = resolve
        })
    )
    let finished = false
    const pending = Promise.resolve(controller.showSessionMenu(testSession().key)).then(() => {
      finished = true
    })
    await Promise.resolve()
    expect(finished).toBe(false)
    dismiss()
    await pending
    expect(finished).toBe(true)
  })
})
