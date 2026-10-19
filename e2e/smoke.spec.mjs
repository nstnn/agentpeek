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
test('built app: fixture bootstrap, live reply, safe detail, persisted pin, no network and cleanup', async ({}, info) => {
  await access(join(ROOT, 'out/main/index.js'))
  const fixture = await createFixture()
  const evidence = { launches: [], actions: [], requests: [], cleanup: null }
  let application
  let page
  const save = async (name) => {
    await page.screenshot({ path: info.outputPath(`${name}.png`) })
    await writeFile(info.outputPath(`${name}.aria.txt`), await page.locator('body').ariaSnapshot())
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
    await expect(page.getByText(/Showing the first 6,000/)).toBeVisible()
    await page.getByRole('button', { name: 'Show Full Message' }).click()
    await expect(page.getByText(/Showing the first 200,000/)).toBeVisible()
    await save('long-message')
    evidence.actions.push({
      action: 'All Sessions; hostile detail; long detail; Show Full Message'
    })
    await close()

    await launch()
    await page.getByRole('button', { name: /^Pinned/ }).click()
    await expect(page.getByRole('option')).toHaveCount(1)
    await expect(page.getByRole('option', { name: /^Fixture Codex complete,/ })).toHaveAttribute(
      'aria-label',
      /pinned/
    )
    await save('pin-after-relaunch')
    evidence.actions.push({ action: 'relaunch; Pinned', persisted: true })
    await close()
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
