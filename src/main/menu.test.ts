import type { MenuItemConstructorOptions } from 'electron'
import { describe, expect, it } from 'vitest'
import { buildMenuTemplate } from './menu'

function submenuOf(template: MenuItemConstructorOptions[], label: string) {
  const menu = template.find((item) => item.label === label)
  return menu?.submenu as MenuItemConstructorOptions[]
}

describe('buildMenuTemplate', () => {
  it('has the AgentPeek, Edit, View, and Window menus in order', () => {
    const labels = buildMenuTemplate({ isDev: false }).map((item) => item.label)
    expect(labels).toEqual(['AgentPeek', 'Edit', 'View', 'Window'])
  })

  it('offers only About and Quit in the app menu, and Copy and Select All in Edit', () => {
    const template = buildMenuTemplate({ isDev: false })
    const roles = (label: string) =>
      submenuOf(template, label)
        .filter((item) => item.role)
        .map((item) => item.role)
    expect(roles('AgentPeek')).toEqual(['about', 'quit'])
    expect(roles('Edit')).toEqual(['copy', 'selectAll'])
  })

  it('has a disabled Reload Sessions item on Command-R', () => {
    const [reload] = submenuOf(buildMenuTemplate({ isDev: false }), 'View')
    expect(reload).toMatchObject({
      id: 'reload-sessions',
      label: 'Reload Sessions',
      accelerator: 'CommandOrControl+R',
      enabled: false
    })
  })

  it('shows developer tools only in development', () => {
    const hasDevTools = (isDev: boolean) =>
      submenuOf(buildMenuTemplate({ isDev }), 'View').some((item) => item.role === 'toggleDevTools')
    expect(hasDevTools(false)).toBe(false)
    expect(hasDevTools(true)).toBe(true)
  })
})
