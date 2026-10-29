import { readFile, writeFile } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { _electron, expect, test } from '@playwright/test'
import { createFixture, removeFixture } from '../scripts/fixture/home.mjs'
import { CWD } from '../scripts/fixture/records.mjs'
import { profileProcesses, stopProfile } from './cleanup.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const OWNER = 'owner@example.com'
const HOST = 'synthetic-mac.example-tailnet.ts.net'
async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return server.address().port
}
async function freePort() {
  const server = createServer()
  const port = await listen(server)
  await new Promise((resolve) => server.close(resolve))
  return port
}
/** One open synthetic viewer stream: its first status, and a way to end it. */
function openStream(port) {
  let req
  const first = new Promise((resolve, reject) => {
    req = request(
      {
        host: '127.0.0.1',
        port,
        path: '/v1/status',
        headers: { Host: HOST, 'Tailscale-User-Login': OWNER }
      },
      (res) => {
        let text = ''
        res.on('data', (chunk) => {
          text += chunk
          const match = /data: (.+)\n\n/.exec(text)
          if (match) {
            // Heartbeats come every 15 s; the stream stays open until `close`.
            req.setTimeout(0)
            resolve(JSON.parse(match[1]))
          }
        })
      }
    )
    req.on('error', reject)
    req.setTimeout(5000, () => req.destroy(new Error('No synthetic status received')))
    req.end()
  })
  return { first, close: () => req.destroy() }
}

// TASK-042: the real built app, real settings file and real loopback listener, synthetic data.
// eslint-disable-next-line no-empty-pattern
test('Remote View outside Settings: sidebar label, detail alias and live viewer count', async ({}, info) => {
  test.setTimeout(90000)
  const fixture = await createFixture()
  const file = join(fixture.userData, 'remote-view.json')
  const port = await freePort()
  const busy = createServer()
  const busyPort = await listen(busy)
  let application
  let page
  const evidence = { launches: [], actions: [], aliases: {}, streamTitles: [], cleanup: null }
  const errors = []
  const capture = async (name) => {
    await page.screenshot({ path: info.outputPath(`${name}.png`) })
    await writeFile(info.outputPath(`${name}.aria.txt`), await page.locator('body').ariaSnapshot())
    evidence.actions.push({ name })
  }
  const seed = (change) =>
    writeFile(
      file,
      JSON.stringify({
        version: 1,
        enabled: true,
        ownerLogin: OWNER,
        hostName: HOST,
        port,
        sharedWorkspaces: [CWD],
        shareTitles: false,
        ...change
      })
    )
  const launch = async () => {
    const env = {
      ...process.env,
      AGENTPEEK_HOME: fixture.home,
      AGENTPEEK_USER_DATA: fixture.userData
    }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.ELECTRON_RENDERER_URL
    delete env.AGENTPEEK_E2E_BACKGROUND
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
    await expect(page.getByRole('tree')).toBeVisible()
    evidence.launches.push(application.process().pid)
  }
  const quit = async () => {
    const child = application.process()
    await application.close()
    application = undefined
    expect(child.exitCode).toBe(0)
    await expect.poll(() => profileProcesses(fixture.userData)).toEqual([])
  }
  const label = () => page.getByRole('button', { name: /^Remote View on\./ })
  const alias = () => page.locator('.detail-remote-alias')
  const settings = () => page.getByRole('button', { name: 'Settings', exact: true })
  const remoteSwitch = () => page.getByRole('switch', { name: 'Remote View', exact: true })
  const rows = () => page.getByRole('treeitem', { name: /^Fixture / })
  try {
    // Saved ON: the label appears once the listener runs, with Settings closed.
    await seed()
    await launch()
    await expect(label()).toBeVisible()
    await expect(label()).toHaveAttribute(
      'title',
      `On, port ${port}. Turned on again because it was on when AgentPeek quit.`
    )
    await capture('label-resumed')

    // Every listed session's desktop alias is the title the viewer stream carries for it.
    await page.getByRole('button', { name: /^All/ }).click()
    const viewer = openStream(port)
    const status = await viewer.first
    const streamTitles = status.status.projects.flatMap((project) =>
      project.sessions.map((row) => row.title)
    )
    evidence.streamTitles = streamTitles
    const count = await rows().count()
    expect(count).toBeGreaterThan(1)
    for (let index = 0; index < count; index += 1) {
      const row = rows().nth(index)
      const name = (await row.getAttribute('aria-label')) ?? `row ${index}`
      await row.click()
      await expect(alias()).toHaveText(/^Remote: Session \d+$/)
      evidence.aliases[name.split(',')[0]] = (await alias().textContent()).slice('Remote: '.length)
    }
    const desktop = Object.values(evidence.aliases)
    expect(new Set(desktop).size).toBe(desktop.length)
    expect([...desktop].sort()).toEqual([...streamTitles].sort())
    await capture('alias-matches-viewer')

    // Open Settings counts the open stream and its end without another action.
    await settings().click()
    await expect(page.getByText(`On, port ${port}. 1 viewer page open.`)).toBeVisible()
    await capture('settings-one-viewer')
    viewer.close()
    await expect(page.getByText(`On, port ${port}. 1 viewer page open.`)).toHaveCount(0)
    await expect(page.getByText(/^On, port \d+\. /)).toBeVisible()
    await capture('settings-viewer-closed')

    // Titles shared: no alias line; hidden again: it returns.
    const titles = page.getByRole('switch', { name: 'Share session titles' })
    await titles.click()
    await expect(titles).toHaveAttribute('aria-checked', 'true')
    await page.keyboard.press('Escape')
    await expect(alias()).toHaveCount(0)
    await capture('titles-shared-no-alias')
    await settings().click()
    await titles.click()
    await expect(titles).toHaveAttribute('aria-checked', 'false')
    await page.keyboard.press('Escape')
    await expect(alias()).toHaveText(/^Remote: Session \d+$/)

    // A connection change restarts with a new ID secret: aliases still match the new stream.
    await settings().click()
    const other = await freePort()
    await page.getByRole('textbox', { name: 'Port', exact: true }).fill(String(other))
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText(/^Saved\./)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(label()).toHaveAttribute('title', new RegExp(`^On, port ${other}\\.`))
    const after = openStream(other)
    const restarted = (await after.first).status.projects.flatMap((project) =>
      project.sessions.map((row) => row.title)
    )
    after.close()
    await expect(alias()).toHaveText(/^Remote: Session \d+$/)
    expect(restarted).toContain((await alias().textContent()).slice('Remote: '.length))
    await capture('alias-after-restart')

    // OFF clears both at once.
    await settings().click()
    await remoteSwitch().click()
    await expect(remoteSwitch()).toHaveAttribute('aria-checked', 'false')
    await page.keyboard.press('Escape')
    await expect(label()).toHaveCount(0)
    await expect(alias()).toHaveCount(0)
    await capture('off-no-label-no-alias')
    await quit()

    // Saved ON with a taken port: never shown as on.
    await seed({ port: busyPort })
    await launch()
    await settings().click()
    await expect(
      page.getByText(`Port ${busyPort} is already used by another app.`, { exact: false })
    ).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(label()).toHaveCount(0)
    await capture('start-failed-no-label')
    expect(JSON.parse(await readFile(file, 'utf8')).enabled).toBe(false)
    expect(errors).toEqual([])
    const requests = await application.evaluate(() => globalThis.agentpeekSmokeAudit)
    expect(requests.every((entry) => entry.ownFile)).toBe(true)
    await quit()
  } catch (error) {
    evidence.failure = error.message
    if (page) await capture('failure').catch(() => undefined)
    throw error
  } finally {
    if (application) await application.close().catch(() => undefined)
    await stopProfile(fixture.userData)
    await new Promise((resolve) => busy.close(resolve))
    evidence.cleanup = { processes: profileProcesses(fixture.userData), errors }
    await writeFile(info.outputPath('evidence.json'), JSON.stringify(evidence, null, 2))
    await removeFixture(fixture.home)
  }
})
