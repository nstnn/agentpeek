import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { _electron, expect, test } from '@playwright/test'
import { createFixture, removeFixture } from '../scripts/fixture/home.mjs'
import { profileProcesses, stopProfile } from './cleanup.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

// eslint-disable-next-line no-empty-pattern
test('Sources: footer, keyboard switches, disabled reading, save recovery and cold restart', async ({}, info) => {
  const fixture = await createFixture()
  const evidence = { actions: [], launches: [], cleanup: null }
  const errors = []
  let application
  let page
  const preferences = join(fixture.userData, 'preferences.json')
  const stateFile = join(fixture.userData, 'state.json')
  const save = async (name) => {
    await page.screenshot({ path: info.outputPath(`${name}.png`) })
    await writeFile(info.outputPath(`${name}.aria.txt`), await page.locator('body').ariaSnapshot())
    evidence.actions.push(name)
  }
  const health = (tool) =>
    page.evaluate(
      async (tool) => (await globalThis.window.agentpeek.getSnapshot()).health[tool].state,
      tool
    )
  const choose = async (tool, enabled, key = false) => {
    const toggle = page.getByRole('switch', {
      name: `Monitor ${tool === 'codex' ? 'Codex' : 'Claude Code'}`,
      exact: true
    })
    await expect(toggle).toHaveAttribute('aria-disabled', 'false')
    if (key) await toggle.press('Space')
    else await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', String(enabled))
    await expect(toggle).toHaveAttribute('aria-disabled', 'false')
    await expect
      .poll(async () => JSON.parse(await readFile(preferences, 'utf8')).sources[tool])
      .toBe(enabled)
    if (!enabled) await expect.poll(() => health(tool)).toBe('off')
    if (key) await expect(toggle).toBeFocused()
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
    await expect(page.locator('.app-shell')).toBeVisible()
    await application.evaluate(({ app, BrowserWindow }) => {
      app.focus({ steal: true })
      BrowserWindow.getAllWindows()[0].focus()
    })
    evidence.launches.push(application.process().pid)
  }
  const close = async () => {
    const audit = await application.evaluate(() => globalThis.agentpeekSmokeAudit)
    expect(audit.length).toBeGreaterThan(0)
    expect(audit.every((request) => request.ownFile)).toBe(true)
    const child = application.process()
    await application.close()
    application = undefined
    expect(child.exitCode).toBe(0)
    await expect.poll(() => profileProcesses(fixture.userData)).toEqual([])
  }
  try {
    await launch()
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('radio', { name: 'Light', exact: true }).check()
    await expect(page.getByText('Saving appearance…')).toHaveCount(0)
    await page.keyboard.press('Escape')
    const footer = page.locator('.sidebar-footer')
    await expect(footer.getByRole('img', { name: /source: Connected/ })).toHaveCount(2)
    await save('sources-footer-before-clicks-light')
    for (const name of ['Codex', 'Claude Code']) {
      await footer.getByRole('img', { name: `${name} source: Connected` }).click()
      await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0)
    }
    expect(
      await footer.evaluate((element) => {
        const bounds = element.getBoundingClientRect()
        return (
          bounds.bottom <= globalThis.window.innerHeight &&
          bounds.top > globalThis.window.innerHeight / 2
        )
      })
    ).toBe(true)
    await expect(page.getByRole('switch')).toHaveCount(0)
    await save('sources-footer-light')
    await page.getByRole('radio', { name: 'Status', exact: true }).click()
    await page.getByRole('option', { name: /^Fixture Codex complete,/ }).click()
    await page.getByRole('button', { name: 'Pin', exact: true }).click()
    await expect
      .poll(async () =>
        JSON.parse(await readFile(stateFile, 'utf8')).sessions.some((entry) => entry.pinned)
      )
      .toBe(true)
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await expect(page.getByRole('switch', { name: 'Monitor Codex' })).toHaveAttribute(
      'aria-checked',
      'true'
    )
    await save('sources-settings-light')
    // From Close, Tab passes the selected theme radio and reaches the first source switch.
    await page.keyboard.press('Tab')
    await page.keyboard.press('Tab')
    await expect(page.getByRole('switch', { name: 'Monitor Codex' })).toBeFocused()
    await choose('codex', false, true)
    await save('sources-codex-off')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('heading', { name: 'Codex monitoring is off' })).toBeVisible()
    await expect(footer.getByRole('img', { name: 'Codex source: Connected' })).toHaveCount(0)
    await expect(page.getByRole('option', { name: /Fixture Codex/ })).toHaveCount(0)
    await expect(footer.getByRole('img', { name: 'Claude Code source: Connected' })).toBeVisible()
    await save('sources-reading-off')
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('radio', { name: 'Dark', exact: true }).check()
    await expect(page.getByText('Saving appearance…')).toHaveCount(0)
    await choose('claude', false)
    await expect
      .poll(() => application.evaluate(({ nativeTheme }) => nativeTheme.themeSource))
      .toBe('dark')
    await expect
      .poll(() =>
        page.evaluate(() => globalThis.window.matchMedia('(prefers-color-scheme: dark)').matches)
      )
      .toBe(true)
    await save('sources-both-off-dark')
    await page.keyboard.press('Escape')
    await expect(page.getByText('No sources connected', { exact: true })).toBeVisible()
    await expect(
      page.getByRole('heading', { name: 'Monitoring is off', exact: true })
    ).toBeVisible()
    await expect(
      page
        .getByRole('main', { name: 'Sessions' })
        .getByRole('button', { name: 'Open Settings', exact: true })
    ).toBeVisible()
    await save('sources-footer-empty-dark')
    await page.getByRole('button', { name: 'Collapse Views' }).click()
    await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible()
    await save('sources-rail-empty-dark')
    await close()

    await launch()
    expect(await health('codex')).toBe('off')
    expect(await health('claude')).toBe('off')
    await page.getByRole('button', { name: 'Open Settings', exact: true }).click()
    await expect(page.getByRole('radio', { name: 'Dark', exact: true })).toBeChecked()
    await expect(page.getByRole('switch', { name: 'Monitor Codex' })).toHaveAttribute(
      'aria-checked',
      'false'
    )
    await save('sources-cold-start-off')
    // Only the owned synthetic profile is changed to exercise a real save failure.
    const before = await readFile(preferences, 'utf8')
    await mkdir(`${preferences}.tmp`)
    await page.getByRole('switch', { name: 'Monitor Codex' }).click()
    await expect(page.getByRole('alert')).toContainText("Couldn't update Codex monitoring")
    expect(await health('codex')).toBe('off')
    expect(await readFile(preferences, 'utf8')).toBe(before)
    await save('sources-save-failure')
    await rm(`${preferences}.tmp`, { recursive: true })
    await choose('codex', true)
    await choose('claude', true)
    await expect.poll(() => health('codex')).toBe('connected')
    await expect.poll(() => health('claude')).toBe('connected')
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: /^Pinned / }).click()
    await expect(page.getByRole('treeitem', { name: /^Fixture Codex complete,/ })).toBeVisible()
    await page.getByRole('button', { name: 'Collapse Views' }).click()
    await save('sources-rail-connected-dark')
    for (const name of ['Codex', 'Claude Code']) {
      await page.getByRole('img', { name: `${name} source: Connected` }).click()
      await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0)
    }
    await page.getByRole('button', { name: /^Pinned / }).click()
    await page.keyboard.press('Tab')
    await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeFocused()
    await save('sources-rail-status-only-dark')
    await page.keyboard.press('Enter')
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(760, 480)
    )
    await page.getByRole('switch', { name: 'Monitor Claude Code' }).scrollIntoViewIfNeeded()
    await save('sources-settings-minimum-dark')
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press(i < 4 ? 'Tab' : 'Shift+Tab')
      expect(
        await page.evaluate(() => !!globalThis.window.document.activeElement?.closest('dialog'))
      ).toBe(true)
    }
    await page.getByRole('radio', { name: 'Light', exact: true }).check()
    await expect(page.getByText('Saving appearance…')).toHaveCount(0)
    await page.getByRole('switch', { name: 'Monitor Claude Code' }).scrollIntoViewIfNeeded()
    await expect
      .poll(() =>
        page.evaluate(() => globalThis.window.matchMedia('(prefers-color-scheme: dark)').matches)
      )
      .toBe(false)
    await save('sources-settings-minimum-light')
    const layout = await page.locator('dialog').evaluate((element) => {
      const bounds = element.getBoundingClientRect()
      return {
        fits:
          bounds.top >= 0 &&
          bounds.bottom <= globalThis.window.innerHeight &&
          bounds.width <= globalThis.window.innerWidth,
        overflow:
          globalThis.window.document.documentElement.scrollWidth > globalThis.window.innerWidth
      }
    })
    expect(layout).toEqual({ fits: true, overflow: false })
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeFocused()
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await choose('codex', false)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeFocused()
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await choose('codex', true)
    await page.keyboard.press('Escape')
    expect(errors).toEqual([])
    await close()
  } finally {
    if (application) await application.close().catch(() => undefined)
    await stopProfile(fixture.userData)
    const remainingPids = profileProcesses(fixture.userData)
    if (!remainingPids.length) await removeFixture(fixture.home)
    evidence.cleanup = { remainingPids, fixtureRemoved: !remainingPids.length }
    evidence.errors = errors
    await writeFile(info.outputPath('evidence.json'), JSON.stringify(evidence, null, 2))
  }
})
