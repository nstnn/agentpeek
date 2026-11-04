import { chmod, readFile, writeFile } from 'node:fs/promises'
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
function firstStatus(port) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: '/v2/status',
        headers: { Host: HOST, 'Tailscale-User-Login': OWNER }
      },
      (res) => {
        let text = ''
        res.on('data', (chunk) => {
          text += chunk
          const match = /data: (.+)\n\n/.exec(text)
          if (match) {
            resolve(JSON.parse(match[1]))
            req.destroy()
          }
        })
      }
    )
    req.on('error', reject)
    req.setTimeout(5000, () => req.destroy(new Error('No synthetic status received')))
    req.end()
  })
}

// Uses the real built app, real settings file and real loopback listener. Only the save latency
// fault is injected: a single fs handle.sync waits for release; feature actions use UI controls.
// eslint-disable-next-line no-empty-pattern
test('Remote settings: durable privacy retries, restart failure and pending Settings remount', async ({}, info) => {
  test.setTimeout(90000)
  const fixture = await createFixture()
  const file = join(fixture.userData, 'remote-view.json')
  const port = await freePort()
  const busy = createServer()
  const busyPort = await listen(busy)
  let application
  let page
  const evidence = { launches: [], actions: [], cleanup: null }
  const errors = []
  const saved = async () => JSON.parse(await readFile(file, 'utf8'))
  const capture = async (name) => {
    await page.screenshot({ path: info.outputPath(`${name}.png`) })
    await writeFile(info.outputPath(`${name}.aria.txt`), await page.locator('body').ariaSnapshot())
    evidence.actions.push({ name })
  }
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
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
  }
  const quit = async () => {
    const child = application.process()
    await application.close()
    application = undefined
    expect(child.exitCode).toBe(0)
    await expect.poll(() => profileProcesses(fixture.userData)).toEqual([])
  }
  const remoteSwitch = () => page.getByRole('switch', { name: 'Remote View', exact: true })
  const retry = () => page.getByRole('button', { name: 'Retry saving Remote View settings' })
  try {
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        enabled: true,
        ownerLogin: OWNER,
        hostName: HOST,
        port,
        sharedWorkspaces: [CWD],
        shareTitles: true
      })
    )
    await launch()
    await expect(remoteSwitch()).toHaveAttribute('aria-checked', 'true')
    await page.getByRole('button', { name: 'Remove fixture-demo' }).scrollIntoViewIfNeeded()
    await capture('projects-before')
    await chmod(fixture.userData, 0o500)
    await page.getByRole('button', { name: 'Remove fixture-demo' }).click()
    await expect(retry()).toBeVisible()
    expect((await saved()).sharedWorkspaces).toEqual([CWD])
    expect((await firstStatus(port)).status.projects).toEqual([])
    await capture('projects-save-failed')
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await expect(retry()).toBeVisible()
    await capture('projects-warning-after-reopen')
    await chmod(fixture.userData, 0o700)
    await retry().click()
    await expect(retry()).toHaveCount(0)
    expect((await saved()).sharedWorkspaces).toEqual([])
    await capture('projects-retry-saved')
    await quit()
    await launch()
    await expect(remoteSwitch()).toHaveAttribute('aria-checked', 'true')
    expect((await firstStatus(port)).status.projects).toEqual([])
    await page.getByRole('button', { name: 'Add Project…' }).click()
    await page.getByRole('button', { name: /^fixture-demo/ }).click()
    const titles = page.getByRole('switch', { name: 'Share session titles' })
    await expect(titles).toHaveAttribute('aria-checked', 'true')
    await capture('titles-before')
    await chmod(fixture.userData, 0o500)
    await titles.click()
    await expect(retry()).toBeVisible()
    expect((await saved()).shareTitles).toBe(true)
    expect(
      (await firstStatus(port)).status.projects[0].sessions.every((row) =>
        /^Session \d+$/.test(row.title)
      )
    ).toBe(true)
    await capture('titles-save-failed')
    await chmod(fixture.userData, 0o700)
    await retry().click()
    await expect(retry()).toHaveCount(0)
    expect((await saved()).shareTitles).toBe(false)
    await expect(page.getByText("Couldn't update title sharing. Try again.")).toHaveCount(0)
    await capture('titles-retry-saved')
    await quit()
    await launch()
    expect(
      (await firstStatus(port)).status.projects[0].sessions.every((row) =>
        /^Session \d+$/.test(row.title)
      )
    ).toBe(true)
    await capture('titles-hidden-after-restart')
    await page.getByRole('textbox', { name: 'Port', exact: true }).fill(String(busyPort))
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText(/Connection settings saved. Remote View is now off/)).toBeVisible()
    await expect(remoteSwitch()).toHaveAttribute('aria-checked', 'false')
    expect(await saved()).toMatchObject({ enabled: false, port: busyPort })
    await capture('occupied-port-saved-and-off')
    await page.getByRole('textbox', { name: 'Port', exact: true }).fill(String(port))
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText('Saved.', { exact: true })).toBeVisible()
    // Delay exactly one real write. This changes no app settings or listener state directly.
    await application.evaluate(() => {
      const fs = globalThis.process.getBuiltinModule('node:fs/promises')
      const original = fs.open
      fs.open = async (...args) => {
        const handle = await original(...args)
        if (String(args[0]).endsWith('/remote-view.json.tmp')) {
          fs.open = original
          const sync = handle.sync.bind(handle)
          handle.sync = async () => {
            await new Promise((resolve) => {
              globalThis.releaseRemoteSave = resolve
            })
            await sync()
          }
        }
        return handle
      }
    })
    await remoteSwitch().click()
    await expect
      .poll(() => application.evaluate(() => typeof globalThis.releaseRemoteSave))
      .toBe('function')
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await expect(page.getByText(`Starting on port ${port}…`)).toBeVisible()
    await capture('pending-enable-after-reopen')
    await page
      .getByRole('textbox', { name: 'Mac address', exact: true })
      .fill('synthetic-other.example-tailnet.ts.net')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await application.evaluate(() => {
      globalThis.releaseRemoteSave()
      delete globalThis.releaseRemoteSave
    })
    await expect(remoteSwitch()).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByText(/On, port/)).toBeVisible()
    expect(await saved()).toMatchObject({
      enabled: true,
      hostName: 'synthetic-other.example-tailnet.ts.net'
    })
    await capture('overlap-saved-and-on')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('tree')).toBeVisible()
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await remoteSwitch().click()
    await expect(remoteSwitch()).toHaveAttribute('aria-checked', 'false')
    expect(errors).toEqual([])
    const requests = await application.evaluate(() => globalThis.agentpeekSmokeAudit)
    expect(requests.every((entry) => entry.ownFile)).toBe(true)
    await quit()
  } catch (error) {
    evidence.failure = error.message
    if (page) await capture('failure').catch(() => undefined)
    throw error
  } finally {
    await chmod(fixture.userData, 0o700)
    if (application) await application.close().catch(() => undefined)
    await stopProfile(fixture.userData)
    await new Promise((resolve) => busy.close(resolve))
    evidence.cleanup = { processes: profileProcesses(fixture.userData), errors }
    await writeFile(info.outputPath('evidence.json'), JSON.stringify(evidence, null, 2))
    await removeFixture(fixture.home)
  }
})
