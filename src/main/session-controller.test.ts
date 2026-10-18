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
    controller.showSessionMenu(key)
    expect(service.recentMessages).not.toHaveBeenCalled()
    expect(popup).not.toHaveBeenCalled()
    controller.showSessionMenu(testSession().key)
    expect(popup).toHaveBeenCalledOnce()
    expect(popup.mock.calls[0]?.[0]).toHaveLength(4)
  })
})
