import { access, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { performance } from 'node:perf_hooks'
import { _electron, expect, test } from '@playwright/test'
import { createFixture, removeFixture } from '../scripts/fixture/home.mjs'
import { simulate } from '../scripts/fixture/simulate.mjs'
import { profileProcesses, stopProfile } from './cleanup.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

// Playwright requires fixture arguments to use an object pattern, even without fixtures.
// eslint-disable-next-line no-empty-pattern
test('built app: fixture bootstrap, safe detail, split navigation/read isolation, persisted pin and cleanup', async ({}, info) => {
  await access(join(ROOT, 'out/main/index.js'))
  const fixture = await createFixture()
  const evidence = { launches: [], actions: [], requests: [], cleanup: null }
  let application
  let page
  const save = async (name) => {
    await page.screenshot({ path: info.outputPath(`${name}.png`) })
    await writeFile(info.outputPath(`${name}.aria.txt`), await page.locator('body').ariaSnapshot())
  }
  const dragSession = async (source, target, name, cancel = false) => {
    await application.evaluate(({ app, BrowserWindow }) => {
      app.focus({ steal: true })
      BrowserWindow.getAllWindows()[0].focus()
    })
    await expect
      .poll(() =>
        application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused())
      )
      .toBe(true)
    const cdp = await page.context().newCDPSession(page)
    await source.scrollIntoViewIfNeeded()
    const box = await source.boundingBox()
    if (!box) throw new Error('drag source is hidden')
    let data
    cdp.on('Input.dragIntercepted', (event) => {
      data = event.data
    })
    await cdp.send('Input.setInterceptDrags', { enabled: true })
    try {
      const origin = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
      await cdp.send('Input.dispatchMouseEvent', { ...origin, type: 'mouseMoved', button: 'none' })
      await cdp.send('Input.dispatchMouseEvent', {
        ...origin,
        type: 'mousePressed',
        button: 'left',
        buttons: 1,
        clickCount: 1
      })
      for (let i = 1; i <= 6; i++) {
        await cdp.send('Input.dispatchMouseEvent', {
          x: origin.x + i * 10,
          y: origin.y + 2,
          type: 'mouseMoved',
          button: 'left',
          buttons: 1
        })
      }
      await expect.poll(() => !!data).toBe(true)
      const destination = await target.boundingBox()
      if (!destination) throw new Error('drag target is hidden')
      const point = {
        x: destination.x + destination.width / 2,
        y: destination.y + destination.height / 2,
        data
      }
      await cdp.send('Input.dispatchDragEvent', { ...point, type: 'dragEnter' })
      await cdp.send('Input.dispatchDragEvent', { ...point, type: 'dragOver' })
      await save(`${name}-hover`)
      if (cancel) {
        await page.keyboard.press('Escape')
        await cdp.send('Input.dispatchDragEvent', { ...point, type: 'dragCancel' })
      } else await cdp.send('Input.dispatchDragEvent', { ...point, type: 'drop' })
      evidence.actions.push({ action: 'drag', name, cancel })
    } finally {
      await cdp.send('Input.cancelDragging').catch(() => undefined)
      await cdp.send('Input.setInterceptDrags', { enabled: false }).catch(() => undefined)
      await cdp.send('Input.dispatchMouseEvent', {
        x: box.x + box.width / 2,
        y: box.y + box.height / 2,
        type: 'mouseReleased',
        button: 'left',
        buttons: 0,
        clickCount: 1
      })
      await cdp.detach()
    }
  }
  const audit = async () => {
    const requests = await application.evaluate(() => globalThis.agentpeekSmokeAudit)
    evidence.requests.push(...requests)
    expect(requests.length).toBeGreaterThan(0)
    expect(requests.every((request) => request.ownFile)).toBe(true)
    expect(requests.some((request) => request.url.endsWith('/out/renderer/index.html'))).toBe(true)
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
    await expect(page.locator('.fixture-banner')).toContainText(fixture.home)
    await expect(page.getByRole('heading', { name: 'Active', exact: true })).toBeVisible()
    const paths = await application.evaluate(({ app, BrowserWindow }) => ({
      userData: app.getPath('userData'),
      windows: BrowserWindow.getAllWindows().length,
      sandbox: BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences().sandbox
    }))
    expect(paths).toEqual({ userData: fixture.userData, windows: 1, sandbox: true })
    expect(await page.evaluate(() => typeof globalThis.window.require)).toBe('undefined')
    evidence.launches.push({ pid: application.process().pid, ...paths })
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
  const close = async () => {
    await audit()
    const child = application.process()
    await application.close()
    expect(child.exitCode).toBe(0)
    application = undefined
    await stopProfile(fixture.userData)
  }
  try {
    await launch()
    await expect(page.getByRole('option')).toHaveCount(7)
    await expect(page.getByRole('option', { name: /^Fixture Codex complete,/ })).toContainText(
      'Running'
    )
    await expect(page.getByRole('option', { name: /^Fixture Claude busy,/ })).toContainText(
      'Running'
    )
    expect(
      await page.evaluate(async () => {
        const snapshot = await globalThis.window.agentpeek.getSnapshot()
        return {
          fixture: snapshot.fixture,
          firstLaunch: snapshot.firstLaunch,
          total: snapshot.sessions.length,
          attention: snapshot.needsAttention
        }
      })
    ).toEqual({ fixture: true, firstLaunch: true, total: 100, attention: 0 })
    await save('bootstrap')

    // Keep the target unselected, so read-on-view cannot hide the new-reply transition.
    const before = performance.now()
    await simulate(fixture.home, 'codex-complete')
    await expect(page.getByRole('option', { name: /^Fixture Codex complete,/ })).toContainText(
      'New reply',
      { timeout: 2000 }
    )
    const latencyMs = Math.round(performance.now() - before)
    expect(latencyMs).toBeLessThanOrEqual(2000)
    evidence.actions.push({ action: 'codex-complete', latencyMs })
    await save('live-reply')

    await page.getByRole('option', { name: /^Fixture Codex complete,/ }).click()
    await page.getByRole('button', { name: 'Pin', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Unpin', exact: true })).toBeVisible()
    evidence.actions.push({ action: 'select complete; Pin' })
    await save('pinned')

    await page.getByRole('button', { name: /^All Sessions/ }).click()
    await expect(page.getByRole('option')).toHaveCount(100)
    await page.getByRole('option', { name: /^Fixture Codex hostile,/ }).click()
    await expect(page.getByRole('region', { name: 'Recent messages' })).toContainText(
      'Image: Synthetic remote image'
    )
    await expect(
      page.locator('.transcript img, .transcript script, .transcript iframe')
    ).toHaveCount(0)
    expect(await page.evaluate(() => globalThis.window.fixtureInjected)).toBeUndefined()
    await save('hostile-markdown')
    await page.getByRole('option', { name: /^Fixture Codex long/ }).click()
    const title = page.locator('.detail-title h2')
    const titleToggle = page.getByRole('button', { name: /^Show (Full|Less) Title$/ })
    const titleGeometry = () =>
      title.evaluate((element) => ({
        height: element.getBoundingClientRect().height,
        lineHeight: parseFloat(globalThis.window.getComputedStyle(element).lineHeight)
      }))
    await expect(titleToggle).toBeVisible()
    let geometry = await titleGeometry()
    expect(geometry.height).toBeLessThanOrEqual(geometry.lineHeight * 2 + 1)
    await save('long-title-preview')
    await titleToggle.click()
    await expect(titleToggle).toHaveText('Show Less Title')
    await expect(titleToggle).toBeFocused()
    geometry = await titleGeometry()
    expect(geometry.height).toBeGreaterThan(geometry.lineHeight * 2 + 1)
    await save('long-title-expanded')
    await titleToggle.press('Space')
    await expect(titleToggle).toHaveText('Show Full Title')
    await expect(titleToggle).toBeFocused()
    await expect(page.getByText(/Showing the first 6,000/)).toBeVisible()
    await expect(page.getByText(/Expansion is limited to 200,000/)).toBeVisible()
    const messageToggle = page.getByRole('button', { name: /^(Show More|Collapse Message)$/ })
    const contentId = await messageToggle.getAttribute('aria-controls')
    await messageToggle.click()
    await expect(messageToggle).toHaveText('Collapse Message')
    await expect(messageToggle).toBeFocused()
    await expect(messageToggle).toHaveAttribute('aria-expanded', 'true')
    await expect(messageToggle).toHaveAttribute('aria-controls', contentId)
    await expect(page.getByText(/Showing the first 200,000/)).toBeVisible()
    await save('long-message')
    const transcript = page.getByRole('region', { name: 'Recent messages' })
    for (let i = 0; i < 8; i++) await transcript.press('PageDown')
    await expect(messageToggle).toBeInViewport()
    await expect(page.getByRole('button', { name: 'Back to Message Start' })).toBeInViewport()
    await save('long-message-deep')
    await page.getByRole('button', { name: 'Back to Message Start' }).click()
    await expect(messageToggle).toBeFocused()
    for (let i = 0; i < 8; i++) await transcript.press('PageDown')
    await messageToggle.click()
    await expect(messageToggle).toHaveText('Show More')
    await expect(messageToggle).toBeFocused()
    await expect(page.getByText(/Showing the first 6,000/)).toBeInViewport()
    await save('long-message-collapsed')
    for (const width of [1000, 999, 760]) {
      await application.evaluate(({ BrowserWindow }, width) => {
        BrowserWindow.getAllWindows()[0].setContentSize(width, width === 760 ? 448 : 600)
      }, width)
      if (width < 1000) await page.getByRole('option', { name: /^Fixture Codex long/ }).click()
      await expect(titleToggle).toBeVisible()
      geometry = await titleGeometry()
      expect(geometry.height).toBeLessThanOrEqual(geometry.lineHeight * 2 + 1)
      await titleToggle.click()
      await expect(titleToggle).toBeFocused()
      await titleToggle.press('Space')
      await messageToggle.click()
      for (let i = 0; i < 4; i++) await transcript.press('PageDown')
      await expect(messageToggle).toBeInViewport()
      await messageToggle.click()
      await expect(messageToggle).toBeFocused()
      expect(
        await page.evaluate(
          () =>
            globalThis.window.document.documentElement.scrollWidth - globalThis.window.innerWidth
        )
      ).toBe(0)
      await save(`long-content-${width}`)
      if (width < 1000) {
        await page.keyboard.press('Escape')
        await expect(page.getByRole('listbox')).toBeFocused()
        await save(`long-content-${width}-back`)
      }
    }
    await application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].setSize(1100, 720)
    })
    evidence.actions.push({
      action:
        'All Sessions; hostile detail; long title; Show More; deep scroll; Collapse Message; 1000/999/minimum; Escape'
    })

    // Open with a row drag; explicitly activate the destination before ordinary selection.
    await application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].setContentSize(1440, 688)
    })
    const main = page.locator('[data-pane=main]')
    const second = page.locator('[data-pane=second]')
    await page.getByRole('option', { name: /^Fixture Codex complete,/ }).click()
    await dragSession(
      page.getByRole('option', { name: /^Fixture Codex complete,/ }),
      page.getByRole('region', { name: 'Drop in Right Pane' }),
      'split-open-drag'
    )
    await expect(second).toBeFocused()
    await main.getByRole('region').click()
    await page.getByRole('option', { name: /^Fixture Codex long/ }).click()
    await expect(main.getByRole('heading', { level: 2 })).toContainText('Fixture Codex long')
    await expect(second.getByRole('heading', { level: 2 })).toHaveText('Fixture Codex complete')
    await expect(main).toHaveAttribute('data-active', 'true')
    await expect(page.getByRole('option', { selected: true })).toHaveCount(1)
    await save('split-a-b')

    const busyRow = page.getByRole('option', { name: /^Fixture Claude busy,/ })
    await dragSession(
      busyRow,
      page.getByRole('region', { name: 'Drop in Left Pane' }),
      'split-cancel-drag',
      true
    )
    await expect(main.getByRole('heading', { level: 2 })).toContainText('Fixture Codex long')
    await expect(second.getByRole('heading', { level: 2 })).toHaveText('Fixture Codex complete')
    await second.getByRole('region').click()
    await busyRow.click()
    await expect(second.getByRole('heading', { level: 2 })).toHaveText('Fixture Claude busy')
    await expect(main.getByRole('heading', { level: 2 })).toContainText('Fixture Codex long')
    await dragSession(
      page.getByRole('option', { name: /^Fixture Codex complete,/ }),
      page.getByRole('region', { name: 'Drop in Right Pane' }),
      'split-replace-right'
    )
    await dragSession(
      busyRow,
      page.getByRole('region', { name: 'Drop in Left Pane' }),
      'split-replace-left'
    )
    await expect(main.getByRole('heading', { level: 2 })).toHaveText('Fixture Claude busy')
    await main.getByRole('region').click()
    await page.getByRole('option', { name: /^Fixture Codex long/ }).click()
    await expect(main.getByRole('heading', { level: 2 })).toContainText('Fixture Codex long')
    await application.evaluate(({ app, BrowserWindow }) => {
      app.focus({ steal: true })
      BrowserWindow.getAllWindows()[0].focus()
    })
    await expect
      .poll(() =>
        application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused())
      )
      .toBe(true)
    const replyState = () =>
      page.evaluate(async () => {
        const { sessions } = await globalThis.window.agentpeek.getSnapshot()
        const session = sessions.find((item) => item.summary.title === 'Fixture Codex complete')
        return { newReply: session.attention.newReply, cursor: session.lastReply?.cursor }
      })
    const previousReply = await replyState()
    await simulate(fixture.home, 'codex-reply')
    await expect.poll(replyState).toMatchObject({ newReply: true })
    await expect(second.getByRole('region', { name: 'Right pane recent messages' })).toContainText(
      'Synthetic newer reply.'
    )
    const unreadReply = await replyState()
    expect(unreadReply.cursor).not.toEqual(previousReply.cursor)
    await save('split-inactive-reply')
    await page.getByRole('option', { name: /^Fixture Claude busy,/ }).click()
    await expect(main.getByRole('heading', { level: 2 })).toHaveText('Fixture Claude busy')
    await expect(second.getByRole('heading', { level: 2 })).toHaveText('Fixture Codex complete')
    expect(await replyState()).toEqual(unreadReply)
    await save('split-c-b')
    await second.getByRole('region', { name: 'Right pane recent messages' }).click()
    await expect(second).toHaveAttribute('data-active', 'true')
    await expect.poll(replyState).toEqual({ ...unreadReply, newReply: false })
    await save('split-active-read')

    await application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].setContentSize(999, 600)
    })
    await expect(main).toBeHidden()
    await expect(second).toBeVisible()
    await expect(page.getByRole('radio', { name: 'Right pane', exact: true })).toHaveAttribute(
      'aria-checked',
      'true'
    )
    await page.keyboard.press('Escape')
    await expect(page.getByRole('listbox')).toBeFocused()
    await expect(main).toBeHidden()
    await expect(second).toBeHidden()
    await save('split-compact-back')
    await dragSession(
      busyRow,
      page.getByRole('region', { name: 'Drop in Left Pane' }),
      'split-compact-cancel',
      true
    )
    await expect(main).toBeHidden()
    await expect(second).toBeHidden()
    await simulate(fixture.home, 'codex-reply')
    await expect.poll(replyState).toMatchObject({ newReply: true })
    const hiddenReply = await replyState()
    await page.getByRole('button', { name: 'Return to Sessions', exact: true }).click()
    await expect(second).toBeFocused()
    await expect.poll(replyState).toEqual({ ...hiddenReply, newReply: false })
    await page.getByRole('radio', { name: 'Left pane', exact: true }).click()
    await expect(main).toBeVisible()
    await expect(second).toBeHidden()
    await save('split-compact-main')
    await page.getByRole('button', { name: 'Close Right Pane', exact: true }).click()
    await expect(second).toHaveCount(0)
    await expect(main.getByRole('heading', { level: 2 })).toHaveText('Fixture Claude busy')
    await expect(main.getByRole('button', { name: '‹ All Sessions' })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('listbox')).toBeFocused()
    await save('split-closed-single')
    evidence.actions.push({
      action: 'A/B to C/B; inactive reply; activate/read; compact Back/Return; close to single',
      unreadReply,
      hiddenReply
    })
    // Reopen before quitting: the second launch must start in the single-pane layout.
    await page.getByRole('option', { name: /^Fixture Claude busy,/ }).click()
    await application.evaluate(({ Menu }) =>
      Menu.getApplicationMenu().getMenuItemById('session-open-secondary').click()
    )
    await close()

    await launch()
    await expect(page.locator('[data-pane=second]')).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'No session selected' })).toBeVisible()
    await page.getByRole('button', { name: /^Pinned/ }).click()
    await expect(page.getByRole('option')).toHaveCount(1)
    await expect(page.getByRole('option', { name: /^Fixture Codex complete,/ })).toHaveAttribute(
      'aria-label',
      /pinned/
    )
    await save('pin-after-relaunch')
    evidence.actions.push({ action: 'relaunch; Pinned', persisted: true })
    await close()
  } catch (error) {
    if (application && page) {
      evidence.failureObservation = {
        native: await application
          .evaluate(({ BrowserWindow, Menu }) => ({
            windows: BrowserWindow.getAllWindows().map((w) => ({
              focused: w.isFocused(),
              visible: w.isVisible()
            })),
            markReadEnabled: Menu.getApplicationMenu().getMenuItemById('session-mark-read').enabled
          }))
          .catch(() => null),
        renderer: await page
          .evaluate(() => ({
            documentFocused: globalThis.window.document.hasFocus(),
            windowFocused:
              globalThis.window.document.querySelector('.app-shell')?.dataset.windowFocused,
            activeElement: globalThis.window.document.activeElement?.getAttribute('aria-label'),
            panes: Array.from(globalThis.window.document.querySelectorAll('[data-pane]')).map(
              (p) => ({
                pane: p.dataset.pane,
                active: p.dataset.active,
                hidden: p.hidden,
                title: p.querySelector('h2')?.textContent,
                loading: !!p.querySelector('.message-state'),
                transcript: !!p.querySelector('.transcript')
              })
            )
          }))
          .catch(() => null)
      }
    }
    throw error
  } finally {
    try {
      if (application) await application.close().catch(() => undefined)
      await stopProfile(fixture.userData)
      expect(profileProcesses(fixture.userData)).toEqual([])
    } finally {
      // Retain evidence even on an assertion/launch failure; never keep synthetic copies.
      const remaining = profileProcesses(fixture.userData)
      if (!remaining.length) await removeFixture(fixture.home)
      evidence.cleanup = { remainingPids: remaining, fixtureRemoved: !remaining.length }
      await writeFile(info.outputPath('evidence.json'), JSON.stringify(evidence, null, 2))
    }
  }
})
