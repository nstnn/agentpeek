import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { _electron, expect, test } from '@playwright/test'
import {
  createFixture,
  removeFixture,
  codexPath,
  transcriptPath
} from '../scripts/fixture/home.mjs'
import { IDS, id } from '../scripts/fixture/records.mjs'
import { simulate } from '../scripts/fixture/simulate.mjs'
import { profileProcesses, stopProfile } from './cleanup.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

// eslint-disable-next-line no-empty-pattern
test('Waiting, metadata search and durable pins through cold restarts', async ({}, info) => {
  const fixture = await createFixture()
  const aged = await createFixture({ now: Date.now() - 100 * 86400000 })
  const evidence = { actions: [], launches: [], cleanup: null }
  let application
  let page
  const errors = []
  const save = async (name) => {
    await page.screenshot({ path: info.outputPath(`${name}.png`) })
    await writeFile(info.outputPath(`${name}.aria.txt`), await page.locator('body').ariaSnapshot())
    evidence.actions.push(name)
  }
  const focus = () =>
    application.evaluate(({ app, BrowserWindow }) => {
      app.focus({ steal: true })
      BrowserWindow.getAllWindows()[0].focus()
    })
  const menu = async (label) => {
    await focus()
    await application.evaluate(({ Menu }, text) => {
      const item = Menu.getApplicationMenu()
        .items.find((item) => item.label === 'View')
        .submenu.items.find((item) => item.label === text)
      if (!item || item.enabled === false) throw new Error('Menu item unavailable')
      item.click()
    }, label)
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
      timeout: 15000
    })
    page = await application.firstWindow()
    page.on('pageerror', (error) => errors.push(error.message))
    await expect(page.locator('.fixture-banner')).toContainText(fixture.home)
    await expect
      .poll(() =>
        page.evaluate(
          async () => (await globalThis.window.agentpeek.getSnapshot()).health.codex.state
        )
      )
      .toBe('connected')
    await focus()
    evidence.launches.push(application.process().pid)
  }
  const close = async () => {
    const requests = await application.evaluate(() => globalThis.agentpeekSmokeAudit)
    expect(requests.every((request) => request.ownFile)).toBe(true)
    const child = application.process()
    await application.close()
    application = undefined
    expect(child.exitCode).toBe(0)
    await expect.poll(() => profileProcesses(fixture.userData)).toEqual([])
  }
  const find = async (query) => {
    await menu('Find Session…')
    const input = page.getByRole('combobox')
    await expect(input).toBeFocused()
    await input.fill(query)
    return page.getByRole('dialog', { name: 'Find Session', exact: true })
  }
  try {
    await launch()
    await save('initial')
    await simulate(fixture.home, 'claude-waiting')
    await menu('Reload Sessions')
    await expect(page.getByRole('button', { name: 'Inbox 1', exact: true })).toBeVisible()
    await menu('Inbox')
    await page.getByRole('radio', { name: 'Status', exact: true }).click()
    await save('waiting-in-inbox')
    await page.getByRole('option', { name: /^Fixture Claude busy,/ }).click()
    await expect(page.getByRole('button', { name: 'Inbox 1', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Mark Read', exact: true })).toBeDisabled()
    await save('waiting-remains-after-viewing')
    await page.getByRole('radio', { name: 'Codex 0', exact: true }).click()
    await find('Fixture Claude bulk 1')
    await expect(
      page.getByRole('option', { name: /^Fixture Claude bulk 1 Claude Code/ })
    ).toBeVisible()
    await page.getByRole('combobox').fill(id(500))
    await expect(page.getByRole('option')).toHaveCount(1)
    await save('find-other-tool-by-id')
    await page.keyboard.press('Enter')
    await expect(
      page.getByRole('heading', { name: 'Fixture Claude bulk 1', exact: true })
    ).toBeVisible()
    await page.getByRole('button', { name: 'Pin', exact: true }).click()
    await find('Fixture Codex complete')
    await page.keyboard.press('Enter')
    await expect(
      page.getByRole('heading', { name: 'Fixture Codex complete', exact: true })
    ).toBeVisible()
    await page.getByRole('button', { name: 'Pin', exact: true }).click()
    await page.keyboard.press('Meta+k')
    await expect(page.getByRole('dialog', { name: 'Find Session', exact: true })).toBeVisible()
    await page.getByRole('combobox').fill('/Users/synthetic/projects/fixture-demo')
    await expect(page.getByRole('option').first()).toBeVisible()
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Tab')
      expect(
        await page.evaluate(() => !!globalThis.window.document.activeElement?.closest('dialog'))
      ).toBe(true)
    }
    await page.getByRole('combobox').focus()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Home')
    await page.getByRole('combobox').fill('no-such-synthetic-session')
    await expect(page.getByText(/No matching sessions/)).toBeVisible()
    await simulate(fixture.home, 'codex-complete')
    // Reload is an external source change here; use a focus/reconcile after closing only if the watcher cannot observe it.
    await expect
      .poll(() =>
        page.evaluate(
          async () =>
            (await globalThis.window.agentpeek.getSnapshot()).sessions.find(
              (s) => s.key.id === '00000000-0000-4000-8000-000000000001'
            ).attention.newReply
        )
      )
      .toBe(true)
    await save('search-pauses-covered-reply')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(
      page.getByRole('heading', { name: 'Fixture Codex complete', exact: true })
    ).toBeVisible()
    await save('search-cancel-restores-detail')
    await close()
    await rm(fixture.home, { recursive: true })
    await cp(aged.home, fixture.home, { recursive: true, preserveTimestamps: true })
    await launch()
    await menu('Pinned')
    await expect(page.getByRole('treeitem', { name: /^Fixture Codex complete,/ })).toBeVisible()
    await expect(page.getByRole('treeitem', { name: /^Fixture Claude bulk 1,/ })).toBeVisible()
    await save('pins-after-100-days-and-restart')
    const codex = codexPath(fixture.home, IDS.complete)
    const claude = transcriptPath(fixture.home, id(500))
    await rm(codex)
    await rm(claude)
    await menu('Reload Sessions')
    await expect(page.getByRole('treeitem', { name: /^Unavailable pinned session/ })).toHaveCount(2)
    await save('pins-unavailable')
    await close()
    await launch()
    await menu('Pinned')
    await expect(page.getByRole('treeitem', { name: /^Unavailable pinned session/ })).toHaveCount(2)
    await save('unavailable-pins-after-restart')
    await cp(codexPath(aged.home, IDS.complete), codex, { preserveTimestamps: true })
    await menu('Reload Sessions')
    await expect(page.getByRole('treeitem', { name: /^Fixture Codex complete,/ })).toBeVisible()
    await save('old-pin-recovered')
    await page.getByRole('treeitem', { name: /^Unavailable pinned session/ }).click()
    await expect(page.getByRole('button', { name: 'Open Claude', exact: true })).toBeDisabled()
    await page.getByRole('button', { name: 'Unpin', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Pinned 1', exact: true })).toBeVisible()
    await expect(page.getByRole('treeitem', { name: /^Unavailable pinned session/ })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Pin', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Unpin', exact: true })).toHaveCount(0)
    await save('unavailable-pin-removed')
    const saved = JSON.parse(await readFile(join(fixture.userData, 'state.json'), 'utf8'))
    expect(
      saved.sessions.every(
        (entry) =>
          Object.keys(entry).sort().join(',') ===
          'acknowledgedErrorCursor,id,lastListedAt,pinned,seenCursor,tool'
      )
    ).toBe(true)
    expect(errors).toEqual([])
    await close()
  } finally {
    if (application) await application.close().catch(() => undefined)
    await stopProfile(fixture.userData)
    evidence.cleanup = { remaining: profileProcesses(fixture.userData) }
    await removeFixture(fixture.home)
    await removeFixture(aged.home)
    await mkdir(info.outputDir, { recursive: true })
    await writeFile(info.outputPath('evidence.json'), JSON.stringify(evidence, null, 2))
  }
})
