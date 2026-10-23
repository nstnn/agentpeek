import type { MenuItemConstructorOptions } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { buildMenuTemplate, buildSessionMenu } from './menu'
import { testSession } from './test-support'

const actions = () => ({
  open: vi.fn(),
  markRead: vi.fn(),
  pin: vi.fn(),
  copy: vi.fn(),
  openPrimary: vi.fn(),
  openSecondary: vi.fn(),
  closeSecondary: vi.fn(),
  back: vi.fn()
})
function options(isDev = false) {
  return {
    isDev,
    reload: vi.fn(),
    command: vi.fn(),
    session: null,
    actions: actions(),
    canGoBack: false,
    canCloseSecondary: false
  }
}
function submenuOf(template: MenuItemConstructorOptions[], label: string) {
  return template.find((item) => item.label === label)?.submenu as MenuItemConstructorOptions[]
}
const click = (item: MenuItemConstructorOptions | undefined) => {
  if (!item?.click) throw new Error('Missing menu click')
  item.click(null as never, null as never, null as never)
}

describe('application menu', () => {
  it('opens Settings through the application menu with Command-comma', () => {
    const opts = options()
    const settings = submenuOf(buildMenuTemplate(opts), 'AgentPeek').find(
      (item) => item.label === 'Settings…'
    )
    expect(settings?.accelerator).toBe('CommandOrControl+,')
    click(settings)
    expect(opts.command).toHaveBeenCalledWith('settings')
  })
  it('keeps the platform roles and includes the new Session menu in order', () => {
    const template = buildMenuTemplate(options())
    expect(template.map((item) => item.label)).toEqual([
      'AgentPeek',
      'Edit',
      'View',
      'Session',
      'Window'
    ])
    for (const [label, roles] of [
      ['AgentPeek', ['about', 'quit']],
      ['Edit', ['copy', 'selectAll']]
    ] as const) {
      expect(
        submenuOf(template, label)
          .filter((item) => item.role)
          .map((item) => item.role)
      ).toEqual(roles)
    }
  })
  it('enables Reload Sessions on Command-R and dispatches each View command', () => {
    const opts = options()
    const view = submenuOf(buildMenuTemplate(opts), 'View')
    expect(view.filter((item) => item.label).map((item) => [item.label, item.accelerator])).toEqual(
      [
        ['Active', 'CommandOrControl+1'],
        ['Pinned', 'CommandOrControl+2'],
        ['All Sessions', 'CommandOrControl+3'],
        ['Reload Sessions', 'CommandOrControl+R']
      ]
    )
    for (const item of view.filter((item) => item.label)) click(item)
    expect(opts.command.mock.calls).toEqual([['view:active'], ['view:pinned'], ['view:all']])
    expect(opts.reload).toHaveBeenCalledOnce()
    expect(view.find((item) => item.id === 'reload-sessions')?.enabled).toBe(true)
  })
  it('shows developer tools only in development', () => {
    for (const isDev of [true, false])
      expect(
        submenuOf(buildMenuTemplate(options(isDev)), 'View').some(
          (item) => item.role === 'toggleDevTools'
        )
      ).toBe(isDev)
  })
})

describe('session and context menus', () => {
  it('allows Close Second and replacement Back even without a valid session', () => {
    const items = buildSessionMenu(null, actions(), { canCloseSecondary: true, canGoBack: true })
    expect(items.find((item) => item.id === 'session-close-secondary')?.enabled).toBe(true)
    expect(items.find((item) => item.id === 'session-back')?.enabled).toBe(true)
    expect(items.find((item) => item.id === 'session-open-secondary')?.enabled).toBe(false)
    const context = buildSessionMenu(testSession(), actions(), {
      context: true,
      canCloseSecondary: true
    })
    expect(context.some((item) => item.id === 'session-close-secondary')).toBe(false)
  })
  it('disables every session action with no selection', () => {
    expect(
      buildSessionMenu(null, actions())
        .filter((item) => item.label)
        .every((item) => item.enabled === false)
    ).toBe(true)
  })
  it.each([
    [{ waiting: false, newReply: false, error: false }, false],
    [{ waiting: true, newReply: false, error: false }, false],
    [{ waiting: false, newReply: true, error: false }, true],
    [{ waiting: false, newReply: false, error: true }, true]
  ] as const)('enables Mark Read only for a reply or error: %j', (attention, enabled) => {
    expect(
      buildSessionMenu(testSession({ attention }), actions()).find(
        (item) => item.id === 'session-mark-read'
      )?.enabled
    ).toBe(enabled)
  })
  it('uses the selected tool, pin state, shortcuts, and callbacks', () => {
    const callbacks = actions()
    const items = buildSessionMenu(
      testSession({ key: { tool: 'claude', id: 'synthetic' }, pinned: true }),
      callbacks,
      { canGoBack: true, canCloseSecondary: true }
    )
    expect(
      items.filter((item) => item.label).map((item) => [item.label, item.accelerator])
    ).toEqual([
      ['Open in Left Pane', undefined],
      ['Open in Right Pane', undefined],
      ['Open Claude', 'CommandOrControl+O'],
      ['Mark Read', 'Shift+CommandOrControl+U'],
      ['Unpin', 'Shift+CommandOrControl+P'],
      ['Copy Session ID', 'Alt+CommandOrControl+C'],
      ['Close Right Pane', undefined],
      ['Back', 'CommandOrControl+[']
    ])
    for (const item of items.filter((item) => item.label)) click(item)
    for (const callback of Object.values(callbacks)) expect(callback).toHaveBeenCalledOnce()
    expect(items.find((item) => item.id === 'session-back')?.enabled).toBe(true)
    expect(
      buildSessionMenu(testSession(), callbacks).find((item) => item.id === 'session-back')?.enabled
    ).toBe(false)
  })
  it('omits Back from the row context menu', () => {
    const items = buildSessionMenu(testSession(), actions(), { context: true })
    expect(items).toHaveLength(6)
    expect(items.some((item) => item.id === 'session-back')).toBe(false)
  })
})
