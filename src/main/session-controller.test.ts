import { describe, expect, it, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
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
    popup: vi.fn<(template: MenuItemConstructorOptions[]) => void | Promise<void>>(),
    isFocused: () => true
  }
  return { ...options, controller: createSessionController(options) }
}

describe('session controller', () => {
  it('opens the explicit detail or context key and the latest native menu target', async () => {
    const s = setup()
    const a = testSession({ appSessionId: 'local_synthetic' })
    const b = testSession({ key: { tool: 'codex', id: 'second-thread' } })
    s.service.snapshot.mockReturnValue({ ...s.service.snapshot(), sessions: [a, b] })
    s.controller.setSelection(a.key)
    const native = s.controller.actions()
    await s.controller.showSessionMenu(a.key)
    const context = s.popup.mock.calls[0]![0].find((item) => item.id === 'session-open')!
    s.controller.setSelection(b.key)
    native.open()
    context.click!(null as never, null as never, null as never)
    expect(await s.controller.openTool(a.key)).toBe(true)
    // Claude.app's own session ID goes along, so the exact session opens there.
    expect(s.system.openTool.mock.calls).toEqual([
      [b.key, undefined],
      [a.key, 'local_synthetic'],
      [a.key, 'local_synthetic']
    ])
    s.system.openTool.mockClear()
    s.service.snapshot.mockReturnValue({ ...s.service.snapshot(), sessions: [b] })
    expect(await s.controller.openTool(a.key)).toBe(false)
    context.click!(null as never, null as never, null as never)
    expect(s.system.openTool).not.toHaveBeenCalled()
  })
  it('does not open unavailable sessions and preserves the Claude target', async () => {
    const s = setup()
    const missing = testSession({ unavailable: true })
    const claude = testSession({ key: { tool: 'claude', id: 'synthetic-claude' } })
    s.service.snapshot.mockReturnValue({ ...s.service.snapshot(), sessions: [missing, claude] })
    expect(await s.controller.openTool(missing.key)).toBe(false)
    s.controller.setSelection(missing.key)
    s.controller.actions().open()
    expect(s.system.openTool).not.toHaveBeenCalled()
    expect(await s.controller.openTool(claude.key)).toBe(true)
    expect(s.system.openTool).toHaveBeenCalledExactlyOnceWith(claude.key, undefined)
  })
  it('rejects delayed automatic reads for an inactive key while explicit row reads remain valid', () => {
    const s = setup()
    const a = testSession({
      lastReply: {
        cursor: 'a',
        completedAt: 1,
        isError: false,
        errorCode: null,
        newerTurnStarted: false
      }
    })
    const b = testSession({ key: { tool: 'claude', id: 'second' } })
    s.service.snapshot.mockReturnValue({ ...s.service.snapshot(), sessions: [a, b] })
    expect(s.controller.markRead(a.key, 'a')).toBe(false)
    s.controller.setSelection(a.key)
    expect(s.controller.markRead(a.key, 'a')).toBe(true)
    s.service.markRead.mockClear()
    s.controller.setSelection(b.key)
    expect(s.controller.markRead(a.key, 'a')).toBe(false)
    expect(s.service.markRead).not.toHaveBeenCalled()
    expect(s.controller.markRead(a.key)).toBe(true)
    s.controller.setSelection(null, { secondPaneOpen: true })
    expect(s.controller.markRead(a.key, 'a')).toBe(false)
  })
  it('keeps native callbacks current and context callbacks bound to their explicit row', async () => {
    const s = setup()
    const a = testSession()
    const b = testSession({ key: { tool: 'claude', id: 'second' } })
    s.service.snapshot.mockReturnValue({ ...s.service.snapshot(), sessions: [a, b] })
    s.controller.setSelection(a.key)
    const native = s.controller.actions()
    await s.controller.showSessionMenu(a.key)
    const context = s.popup.mock.calls[0]![0].find((item) => item.id === 'session-open-secondary')!
    s.controller.setSelection(b.key)
    native.openSecondary()
    context.click!(null as never, null as never, null as never)
    expect(s.command.mock.calls).toEqual([
      [{ type: 'open-secondary', key: b.key }],
      [{ type: 'open-secondary', key: a.key }]
    ])
    s.command.mockClear()
    s.service.snapshot.mockReturnValue({ ...s.service.snapshot(), sessions: [b] })
    context.click!(null as never, null as never, null as never)
    expect(s.command).not.toHaveBeenCalled()
    s.controller.setSelection(null)
    native.openSecondary()
    expect(s.command).not.toHaveBeenCalled()
  })
  it('binds both placement targets to the context row and rechecks removed keys', async () => {
    const s = setup()
    const a = testSession()
    const b = testSession({ key: { tool: 'claude', id: 'other' } })
    s.service.snapshot.mockReturnValue({ ...s.service.snapshot(), sessions: [a, b] })
    s.controller.setSelection(b.key, { secondPaneOpen: true })
    await s.controller.showSessionMenu(a.key)
    const items = s.popup.mock.calls[0]![0]
    expect(items.slice(0, 2).map((item) => item.label)).toEqual([
      'Open in Left Pane',
      'Open in Right Pane'
    ])
    const left = items.find((item) => item.id === 'session-open-primary')!
    left.click!(null as never, null as never, null as never)
    expect(s.command).toHaveBeenLastCalledWith({ type: 'open-primary', key: a.key })
    s.command.mockClear()
    s.service.snapshot.mockReturnValue({ ...s.service.snapshot(), sessions: [b] })
    left.click!(null as never, null as never, null as never)
    expect(s.command).not.toHaveBeenCalled()
  })
  it('keeps Close Second enabled through browsing/source loss and rechecks late close callbacks', () => {
    const s = setup()
    s.controller.setSelection(testSession().key, { secondPaneOpen: true })
    const actions = s.controller.actions()
    s.service.snapshot.mockReturnValue({ ...s.service.snapshot(), sessions: [] })
    s.controller.publish()
    s.controller.setSelection(null)
    expect(s.controller.canCloseSecondary()).toBe(true)
    actions.closeSecondary()
    expect(s.command).toHaveBeenCalledWith({ type: 'close-secondary' })
    s.controller.setSelection(null, { secondPaneOpen: false })
    s.command.mockClear()
    actions.closeSecondary()
    expect(s.command).not.toHaveBeenCalled()
  })
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
  it('uses replacement navigation for Back independently of width, target and source availability', () => {
    const s = setup()
    const controller = s.controller
    controller.setSelection(testSession().key)
    expect(controller.canGoBack()).toBe(false)
    controller.setDetailOpen(true)
    controller.setSelection(null)
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
    s.controller.setSelection(current.key)
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
    expect(popup.mock.calls[0]?.[0]).toHaveLength(6)
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
