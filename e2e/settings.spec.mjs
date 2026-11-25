import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { _electron, expect, test } from '@playwright/test'
import { createFixture, removeFixture } from '../scripts/fixture/home.mjs'
import { simulate } from '../scripts/fixture/simulate.mjs'
import { profileProcesses, stopProfile } from './cleanup.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

// eslint-disable-next-line no-empty-pattern
test('Settings: appearance, keyboard, covered replies, failed save and cold restart', async ({}, info) => {
  const fixture = await createFixture()
  const evidence = { launches: [], actions: [], cleanup: null }
  let application
  let page
  const errors = []
  const preferences = join(fixture.userData, 'preferences.json')
  const save = async (name) => {
    await page.screenshot({ path: info.outputPath(`${name}.png`) })
    await writeFile(info.outputPath(`${name}.aria.txt`), await page.locator('body').ariaSnapshot())
    evidence.actions.push({ name })
  }
  const nativeTheme = () =>
    application.evaluate(({ nativeTheme }) => ({
      source: nativeTheme.themeSource,
      dark: nativeTheme.shouldUseDarkColors
    }))
  const focus = async () => {
    await application.evaluate(({ app, BrowserWindow }) => {
      app.focus({ steal: true })
      BrowserWindow.getAllWindows()[0].focus()
    })
    await expect
      .poll(() =>
        application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused())
      )
      .toBe(true)
    await expect(page.locator('.app-shell')).toHaveAttribute('data-window-focused', 'true')
  }
  const launch = async () => {
    const env = {
      ...process.env,
      AGENTPEEK_HOME: fixture.home,
      AGENTPEEK_USER_DATA: fixture.userData
    }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.ELECTRON_RENDERER_URL
    application = await _electron.launch({
      args: [`--user-data-dir=${fixture.userData}`, join(ROOT, 'e2e/bootstrap.cjs')],
      cwd: ROOT,
      env,
      chromiumSandbox: true,
      colorScheme: null,
      timeout: 15000
    })
    page = await application.firstWindow()
    page.on('pageerror', (error) => errors.push(error.message))
    await expect(page.locator('.fixture-banner')).toContainText(fixture.home)
    await expect(page.getByRole('tree')).toBeVisible()
    await focus()
    evidence.launches.push({ pid: application.process().pid, theme: await nativeTheme() })
  }
  const close = async () => {
    const requests = await application.evaluate(() => globalThis.agentpeekSmokeAudit)
    expect(requests.length).toBeGreaterThan(0)
    expect(requests.every((request) => request.ownFile)).toBe(true)
    const child = application.process()
    await application.close()
    application = undefined
    expect(child.exitCode).toBe(0)
    await expect.poll(() => profileProcesses(fixture.userData)).toEqual([])
  }
  const choose = async (name) => {
    await page.getByRole('radio', { name, exact: true }).check()
    await expect.poll(async () => (await nativeTheme()).source).toBe(name.toLowerCase())
    await expect(page.getByText('Saving appearance…')).toHaveCount(0)
    await expect
      .poll(async () => JSON.parse(await readFile(preferences, 'utf8')).theme)
      .toBe(name.toLowerCase())
    const native = await nativeTheme()
    expect(
      await page.evaluate(
        () => globalThis.window.matchMedia('(prefers-color-scheme: dark)').matches
      )
    ).toBe(native.dark)
  }
  try {
    await launch()
    await page.getByRole('combobox', { name: 'Group sessions by', exact: true }).click()
    await page.getByRole('option', { name: 'Status', exact: true }).click()
    await page.getByRole('option', { name: /^Fixture Codex complete,/ }).click()
    await expect(page.locator('.transcript')).toBeVisible()
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
    await expect(dialog).toBeVisible()
    await expect(page.getByRole('radio', { name: 'System', exact: true })).toBeChecked()
    await save('settings-system')
    await choose('Dark')
    await save('settings-dark')
    await page.keyboard.press('ArrowLeft')
    await expect(page.getByRole('radio', { name: 'Light', exact: true })).toBeChecked()
    await expect.poll(async () => (await nativeTheme()).source).toBe('light')
    await expect(page.getByText('Saving appearance…')).toHaveCount(0)
    await expect(page.getByRole('radio', { name: 'Light', exact: true })).toBeFocused()
    await save('settings-light-keyboard')
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press(i < 3 ? 'Tab' : 'Shift+Tab')
      expect(
        await page.evaluate(() => !!globalThis.window.document.activeElement?.closest('dialog'))
      ).toBe(true)
    }
    await simulate(fixture.home, 'codex-complete')
    const reply = () =>
      page.evaluate(async () => {
        const snapshot = await globalThis.window.agentpeek.getSnapshot()
        return snapshot.sessions.find(
          (session) => session.summary.title === 'Fixture Codex complete'
        )?.attention.newReply
      })
    await expect.poll(reply).toBe(true)
    // Give the normal asynchronous acknowledgement path an opportunity while the modal covers it.
    await expect
      .poll(() =>
        application.evaluate(
          ({ Menu }) => Menu.getApplicationMenu().getMenuItemById('session-mark-read').enabled
        )
      )
      .toBe(false)
    expect(await reply()).toBe(true)
    await save('settings-covered-unread')
    // CDP keys bypass native activation; a real Escape is sent to a focused app.
    await focus()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeFocused()
    expect(
      await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].isFocused()
      )
    ).toBe(true)
    await expect.poll(reply).toBe(false)

    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(760, 480)
    )
    await expect(page.locator('.detail-pane:not([hidden])')).toBeVisible()
    await application.evaluate(({ Menu }) => {
      const settings = Menu.getApplicationMenu().items[0].submenu.items.find(
        (item) => item.label === 'Settings…'
      )
      if (!settings || !settings.enabled) throw new Error('Settings menu is unavailable')
      settings.click()
    })
    await expect(dialog).toBeVisible()
    await save('settings-minimum')
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(page.locator('.detail-pane:not([hidden])')).toBeVisible()
    await page.getByRole('button', { name: 'Collapse Views' }).click()
    const footer = page.getByRole('button', { name: 'Settings', exact: true })
    await expect(footer).toBeVisible()
    expect(
      await footer.evaluate((element) => {
        const bounds = element.getBoundingClientRect()
        return bounds.bottom <= globalThis.window.innerHeight && bounds.width <= 56
      })
    ).toBe(true)
    await save('settings-rail')
    await footer.click()
    await choose('Dark')

    const previous = await readFile(preferences, 'utf8')
    await mkdir(`${preferences}.tmp`)
    await page.getByRole('radio', { name: 'Light', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText("Couldn't save theme")
    await expect(page.getByRole('radio', { name: 'Dark', exact: true })).toBeChecked()
    expect((await nativeTheme()).source).toBe('dark')
    expect(await readFile(preferences, 'utf8')).toBe(previous)
    await save('settings-save-error')
    await rm(`${preferences}.tmp`, { recursive: true })
    await choose('Light')
    await expect(page.getByRole('alert')).toHaveCount(0)
    await choose('Dark')
    await page.getByRole('button', { name: 'Close Settings' }).click()
    await close()

    await launch()
    expect((await nativeTheme()).source).toBe('dark')
    expect(
      await page.evaluate(
        () => globalThis.window.matchMedia('(prefers-color-scheme: dark)').matches
      )
    ).toBe(true)
    await save('settings-dark-cold-start')
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await expect(page.getByRole('radio', { name: 'Dark', exact: true })).toBeChecked()
    await choose('System')
    await save('settings-system-restored')
    expect(errors).toEqual([])
    await close()
  } catch (error) {
    if (application && page) {
      evidence.failureObservation = {
        native: await application
          .evaluate(({ BrowserWindow, Menu }) => ({
            focused: BrowserWindow.getAllWindows()[0].isFocused(),
            markReadEnabled: Menu.getApplicationMenu().getMenuItemById('session-mark-read').enabled
          }))
          .catch(() => null),
        renderer: await page
          .evaluate(() => ({
            focused: globalThis.window.document.hasFocus(),
            shellFocused:
              globalThis.window.document.querySelector('.app-shell')?.dataset.windowFocused,
            modalOpen: !!globalThis.window.document.querySelector('dialog[open]'),
            activeElement: globalThis.window.document.activeElement?.getAttribute('aria-label'),
            panes: [...globalThis.window.document.querySelectorAll('[data-pane]')].map((pane) => ({
              pane: pane.dataset.pane,
              active: pane.dataset.active,
              hidden: pane.hidden,
              transcript: !!pane.querySelector('.transcript')
            }))
          }))
          .catch(() => null)
      }
      await save('settings-failure').catch(() => undefined)
    }
    throw error
  } finally {
    try {
      if (application) await application.close().catch(() => undefined)
      await stopProfile(fixture.userData)
    } finally {
      const remainingPids = profileProcesses(fixture.userData)
      if (!remainingPids.length) await removeFixture(fixture.home)
      evidence.cleanup = { remainingPids, fixtureRemoved: !remainingPids.length }
      evidence.errors = errors
      await writeFile(info.outputPath('evidence.json'), JSON.stringify(evidence, null, 2))
    }
  }
})
