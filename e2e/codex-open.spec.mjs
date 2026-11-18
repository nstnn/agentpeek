import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { _electron, expect, test } from '@playwright/test'
import { createFixture, removeFixture } from '../scripts/fixture/home.mjs'
import { IDS } from '../scripts/fixture/records.mjs'
import { profileProcesses, stopProfile } from './cleanup.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

// This exercises the built app's real renderer, IPC and menus. Only the OS handoff is faked;
// synthetic chats do not exist in the user's Codex, and this test never opens another app.
// eslint-disable-next-line no-empty-pattern
test('Open Codex hands off the exact detail, active pane and context thread', async ({}, info) => {
  const fixture = await createFixture()
  const evidence = { actions: [], handoffs: [], cleanup: null }
  let application
  let page
  const save = async (name) => {
    await page.screenshot({ path: info.outputPath(`${name}.png`) })
    await writeFile(info.outputPath(`${name}.aria.txt`), await page.locator('body').ariaSnapshot())
    evidence.actions.push(name)
  }
  const menu = async (id) => {
    await expect
      .poll(() =>
        application.evaluate(
          ({ Menu }, id) => Menu.getApplicationMenu().getMenuItemById(id)?.enabled ?? false,
          id
        )
      )
      .toBe(true)
    const item = await application.evaluate(({ Menu }, id) => {
      const item = Menu.getApplicationMenu().getMenuItemById(id)
      if (!item?.enabled) throw new Error(`Menu item unavailable: ${id}`)
      item.click()
      return { label: item.label, accelerator: item.accelerator }
    }, id)
    evidence.actions.push({ menu: id, ...item })
    return item
  }
  const handoffs = () => application.evaluate(() => globalThis.codexOpenAudit.urls)
  try {
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
    await expect(page.locator('.fixture-banner')).toContainText(fixture.home)
    await application.evaluate(({ shell, BrowserWindow }) => {
      globalThis.codexOpenAudit = { urls: [], reject: false }
      shell.openExternal = async (url) => {
        globalThis.codexOpenAudit.urls.push(url)
        if (globalThis.codexOpenAudit.reject) throw new Error('Synthetic handoff failure')
      }
      BrowserWindow.getAllWindows()[0].setContentSize(1440, 900)
    })
    await page.getByRole('button', { name: /^All Sessions / }).click()
    const row = (name) =>
      page.getByRole('treeitem', { name: new RegExp(`^Fixture Codex ${name},`) })
    await row('complete').click()
    const open = page.getByRole('button', { name: 'Open Codex', exact: true })
    await expect(open).toHaveAttribute('title', 'Open this session in Codex')
    await save('detail-actions-before')
    await open.click()
    await expect.poll(handoffs).toEqual([`codex://threads/${IDS.complete}`])
    await save('detail-actions-after')

    await menu('session-open-secondary')
    await row('error').click()
    await expect(page.getByRole('button', { name: 'Open Codex', exact: true })).toHaveCount(2)
    const command = await menu('session-open')
    expect(command.accelerator).toBe('CommandOrControl+O')
    await expect
      .poll(handoffs)
      .toEqual([`codex://threads/${IDS.complete}`, `codex://threads/${IDS.error}`])
    await save('menu-open-codex-active-right')

    // Invoke the native row menu through the renderer's real contextmenu event; choose its
    // captured item instead of leaving a blocking OS popup on the user's screen.
    await application.evaluate(({ Menu }) => {
      globalThis.codexContextItems = null
      Menu.prototype.popup = function (options) {
        globalThis.codexContextItems = this
        options.callback?.()
      }
    })
    await row('aborted').click({ button: 'right' })
    await expect.poll(() => application.evaluate(() => !!globalThis.codexContextItems)).toBe(true)
    await application.evaluate(() => {
      const item = globalThis.codexContextItems.getMenuItemById('session-open')
      if (!item?.enabled) throw new Error('Context Open Codex unavailable')
      item.click()
    })
    await expect
      .poll(handoffs)
      .toEqual([
        `codex://threads/${IDS.complete}`,
        `codex://threads/${IDS.error}`,
        `codex://threads/${IDS.aborted}`
      ])
    await save('menu-open-codex-context-row')
    // The context row must not replace the active reading target.
    await menu('session-open')
    await expect
      .poll(handoffs)
      .toEqual([
        `codex://threads/${IDS.complete}`,
        `codex://threads/${IDS.error}`,
        `codex://threads/${IDS.aborted}`,
        `codex://threads/${IDS.error}`
      ])

    await menu('session-close-secondary')
    await expect(open).toHaveCount(1)
    await application.evaluate(() => {
      globalThis.codexOpenAudit.reject = true
    })
    await open.click()
    await expect(page.getByRole('status')).toHaveText("Couldn't open Codex.")
    await save('detail-actions-handoff-failure')

    // A Claude.app session opens through Claude.app's own link with its catalog `local_` ID.
    await application.evaluate(() => {
      globalThis.codexOpenAudit.reject = false
    })
    await page.getByRole('treeitem', { name: /^Fixture Claude stopped,/ }).click()
    const openClaude = page.getByRole('button', { name: 'Open Claude', exact: true })
    await expect(openClaude).toHaveAttribute('title', 'Open this session in Claude')
    await openClaude.click()
    await expect
      .poll(async () => (await handoffs()).at(-1))
      .toBe(`claude://code/continue?session=local_${IDS.stopped}`)
    await save('detail-actions-open-claude')
    evidence.handoffs = await handoffs()
    const child = application.process()
    await application.close()
    application = undefined
    expect(child.exitCode).toBe(0)
    await expect.poll(() => profileProcesses(fixture.userData)).toEqual([])
    evidence.cleanExit = true
  } finally {
    if (application) await application.close().catch(() => undefined)
    await stopProfile(fixture.userData)
    const remainingPids = profileProcesses(fixture.userData)
    if (!remainingPids.length) await removeFixture(fixture.home)
    evidence.cleanup = { remainingPids, fixtureRemoved: !remainingPids.length }
    await writeFile(info.outputPath('evidence.json'), JSON.stringify(evidence, null, 2))
  }
})
