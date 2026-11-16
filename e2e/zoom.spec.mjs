import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { Buffer } from 'node:buffer'
import { _electron, expect, test } from '@playwright/test'
import { createFixture, removeFixture } from '../scripts/fixture/home.mjs'
import { simulate } from '../scripts/fixture/simulate.mjs'
import { profileProcesses, stopProfile } from './cleanup.mjs'
import { seedDefaultWindow } from './window-state.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

// eslint-disable-next-line no-empty-pattern
test('Zoom: exact steps, bounds, responsive reading, settings, recovery and cold start', async ({}, info) => {
  const fixture = await createFixture()
  await seedDefaultWindow(fixture.userData)
  const file = join(fixture.userData, 'preferences.json')
  const evidence = { actions: [], launches: [], cleanup: null }
  const errors = []
  let application
  let page
  const percent = () =>
    application.evaluate(({ BrowserWindow }) =>
      Math.round(BrowserWindow.getAllWindows()[0].webContents.getZoomFactor() * 100)
    )
  const save = async (name) => {
    // Playwright's viewport clip assumes the original CSS scale. Capture the
    // compositor surface so zoomed evidence includes the whole visible window.
    const png = await application.evaluate(async ({ BrowserWindow }) =>
      (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64')
    )
    await writeFile(info.outputPath(`${name}.png`), Buffer.from(png, 'base64'))
    await writeFile(info.outputPath(`${name}.aria.txt`), await page.locator('body').ariaSnapshot())
    evidence.actions.push({ name, percent: await percent() })
  }
  const menu = async (id) => {
    await application.evaluate(({ app, BrowserWindow, Menu }, id) => {
      app.focus({ steal: true })
      BrowserWindow.getAllWindows()[0].focus()
      const item = Menu.getApplicationMenu().getMenuItemById(id)
      if (!item?.enabled || !item.visible) throw new Error(`Unavailable menu: ${id}`)
      item.click()
    }, id)
    evidence.actions.push({ menu: id })
  }
  const zoom = async (id, expected) => {
    await menu(id)
    await expect.poll(percent).toBe(expected)
    await expect(page.getByRole('status')).toHaveText(`Zoom ${expected}%`)
    await expect
      .poll(async () => JSON.parse(await readFile(file, 'utf8')).zoomPercent)
      .toBe(expected)
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
    evidence.launches.push({ pid: application.process().pid, percent: await percent() })
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
  const fits = () =>
    page.evaluate(() => {
      const root = globalThis.document.documentElement
      const dialog = globalThis.document.querySelector('dialog[open]')
      const close = dialog?.querySelector('button')?.getBoundingClientRect()
      return {
        noOverflow: root.scrollWidth <= globalThis.innerWidth + 1,
        closeVisible:
          !close ||
          (close.top >= 0 &&
            close.bottom <= globalThis.innerHeight &&
            close.right <= globalThis.innerWidth)
      }
    })
  try {
    await launch()
    expect(await percent()).toBe(100)
    await save('zoom-default')
    await zoom('zoom-in', 110)
    await save('zoom-110')
    await zoom('zoom-out', 100)
    await zoom('zoom-out', 90)
    await zoom('zoom-reset', 100)
    await expect(page.getByRole('status')).toHaveCount(0, { timeout: 3000 })

    await page.getByRole('button', { name: /^All Sessions \d/ }).click()
    await page.getByRole('radio', { name: 'Status', exact: true }).click()
    await page.getByRole('option', { name: /^Fixture Codex long/ }).click()
    const transcript = page.getByRole('region', { name: 'Recent messages' })
    const messageToggle = page.getByRole('button', { name: 'Show More', exact: true })
    await messageToggle.click()
    await transcript.press('PageDown')
    await transcript.press('PageDown')
    const offset = await transcript.evaluate(async (element) => {
      // PageDown animates in Chromium. Measure after the user's scroll settles,
      // otherwise a continuing keyboard scroll looks like a zoom-induced jump.
      let previous = -1
      let stable = 0
      for (let frame = 0; frame < 120; frame++) {
        await new Promise(globalThis.requestAnimationFrame)
        const current = element.scrollTop
        stable = current === previous ? stable + 1 : 0
        if (stable === 4) return current
        previous = current
      }
      throw new Error('Keyboard scroll did not settle')
    })
    expect(offset).toBeGreaterThan(0)
    await zoom('zoom-in', 110)
    await expect
      .poll(() => transcript.evaluate((element) => element.scrollTop))
      .toBeCloseTo(offset, 0)
    await expect(page.getByRole('button', { name: 'Collapse Message', exact: true })).toBeVisible()
    const divider = page.getByRole('separator', { name: 'Sessions width', exact: true })
    const width = Number(await divider.getAttribute('aria-valuenow'))
    const box = await divider.boundingBox()
    if (!box) throw new Error('Zoomed divider is hidden')
    await divider.evaluate((element) => {
      globalThis.zoomPointerObservation = []
      for (const type of ['pointerdown', 'pointermove', 'pointerup'])
        element.addEventListener(type, (event) =>
          globalThis.zoomPointerObservation.push({
            type,
            x: event.clientX,
            width: element.getAttribute('aria-valuenow'),
            max: element.getAttribute('aria-valuemax')
          })
        )
    })
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    // Allow one rendered frame per move, matching a user's drag rather than
    // releasing before Chromium has delivered coalesced pointer moves.
    for (let step = 1; step <= 8; step++) {
      await page.mouse.move(box.x + box.width / 2 + (30 * step) / 8, box.y + box.height / 2)
      await page.evaluate(() => new Promise(globalThis.requestAnimationFrame))
    }
    await page.mouse.up()
    evidence.actions.push({
      name: 'zoom-divider-input',
      box,
      events: await page.evaluate(() => globalThis.zoomPointerObservation)
    })
    await expect
      .poll(async () => Number(await divider.getAttribute('aria-valuenow')))
      .toBe(width + 30)
    await expect
      .poll(() => transcript.evaluate((element) => element.scrollTop))
      .toBeCloseTo(offset, 0)
    await save('zoom-long-reading-divider-110')
    await zoom('zoom-reset', 100)
    await page.getByRole('button', { name: /^Active \d+$/ }).click()

    // Open two real reading targets using the UI, then cross the three-column boundary.
    await page.getByRole('radio', { name: 'Status', exact: true }).click()
    await page.getByRole('option', { name: /^Fixture Codex complete,/ }).click()
    await menu('session-open-secondary')
    await page.getByRole('option', { name: /^Fixture Claude busy,/ }).click()
    await expect(page.locator('.detail-pane:not([hidden])')).toHaveCount(2)
    const keys = () =>
      page.locator('[data-pane]').evaluateAll((panes) =>
        panes.map((pane) => ({
          pane: pane.dataset.pane,
          title: pane.querySelector('h2')?.textContent
        }))
      )
    const before = await keys()
    await zoom('zoom-in', 110)
    await zoom('zoom-in', 120)
    await expect(page.locator('.sessions-pane')).toBeHidden()
    await expect(page.locator('.detail-pane:not([hidden])')).toHaveCount(2)
    expect(await keys()).toEqual(before)
    await save('zoom-split-120')
    await zoom('zoom-reset', 100)
    await expect(page.locator('.sessions-pane')).toBeVisible()

    // An inactive reply stays unread across zoom-induced layout changes.
    await simulate(fixture.home, 'codex-complete')
    const unread = () =>
      page.evaluate(
        async () =>
          (await globalThis.window.agentpeek.getSnapshot()).sessions.find(
            (session) => session.summary.title === 'Fixture Codex complete'
          )?.attention.newReply
      )
    await expect.poll(unread).toBe(true)
    await zoom('zoom-in', 110)
    expect(await unread()).toBe(true)

    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
    await page.getByRole('radio', { name: 'Dark', exact: true }).check()
    await expect(page.getByText('Saving appearance…')).toHaveCount(0)
    expect(
      await page.evaluate(() => globalThis.matchMedia('(prefers-color-scheme: dark)').matches)
    ).toBe(true)
    await zoom('zoom-in', 120)
    await expect(dialog.getByRole('status')).toHaveText('Zoom 120%')
    expect(await unread()).toBe(true)
    await save('zoom-settings-dark')
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)

    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(760, 480)
    )
    for (const expected of [130, 140, 150]) await zoom('zoom-in', expected)
    await expect(page.locator('.detail-pane:not([hidden])')).toHaveCount(1)
    expect(await fits()).toEqual({ noOverflow: true, closeVisible: true })
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    expect(await fits()).toEqual({ noOverflow: true, closeVisible: true })
    await save('zoom-minimum-150-settings')
    await page.keyboard.press('Escape')
    await save('zoom-minimum-150-reading')
    expect(
      await application.evaluate(
        ({ Menu }) => Menu.getApplicationMenu().getMenuItemById('zoom-in').enabled
      )
    ).toBe(false)
    await zoom('zoom-out', 140)
    for (const expected of [130, 120, 110, 100, 90, 80]) await zoom('zoom-out', expected)
    expect(
      await application.evaluate(
        ({ Menu }) => Menu.getApplicationMenu().getMenuItemById('zoom-out').enabled
      )
    ).toBe(false)
    await save('zoom-minimum-80')
    await zoom('zoom-reset', 100)

    const previous = await readFile(file, 'utf8')
    await mkdir(`${file}.tmp`)
    await menu('zoom-in')
    await expect(page.getByRole('status')).toContainText("Couldn't save zoom. Restored to 100%")
    expect(await percent()).toBe(100)
    expect(await readFile(file, 'utf8')).toBe(previous)
    await save('zoom-failed-save')
    await rm(`${file}.tmp`, { recursive: true })
    await zoom('zoom-in', 110)
    await zoom('zoom-in', 120)
    await zoom('zoom-in', 130)
    expect(JSON.parse(await readFile(file, 'utf8')).theme).toBe('dark')
    await close()
    await launch()
    expect(await percent()).toBe(130)
    expect(await application.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('dark')
    expect(
      await page.evaluate(() => globalThis.matchMedia('(prefers-color-scheme: dark)').matches)
    ).toBe(true)
    await save('zoom-cold-start-130')
    await zoom('zoom-reset', 100)
    expect(errors).toEqual([])
    await close()
  } catch (error) {
    if (application && page) await save('zoom-failure').catch(() => undefined)
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
