import { readFile, rm, writeFile } from 'node:fs/promises'
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
async function freePort() {
  const server = createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}
/** The first status frame of a synthetic viewer stream; the stream ends right after it. */
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

// TASK-043: the "Share recent messages" switch in the real built app, with its real settings file
// and loopback listener. Synthetic data only; no message text is read or kept as evidence.
// eslint-disable-next-line no-empty-pattern
test('Share recent messages: off at every launch, only while on, never saved', async ({}, info) => {
  test.setTimeout(90000)
  const fixture = await createFixture()
  const file = join(fixture.userData, 'remote-view.json')
  const port = await freePort()
  let application
  let page
  const evidence = { launches: [], actions: [], frames: [], savedFiles: [], cleanup: null }
  const errors = []
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
  }
  const quit = async () => {
    const child = application.process()
    await application.close()
    application = undefined
    expect(child.exitCode).toBe(0)
    await expect.poll(() => profileProcesses(fixture.userData)).toEqual([])
  }
  const settings = () => page.getByRole('button', { name: 'Settings', exact: true })
  const remoteSwitch = () => page.getByRole('switch', { name: 'Remote View', exact: true })
  const messages = () => page.getByRole('switch', { name: 'Share recent messages' })
  const label = () => page.getByRole('button', { name: /^Remote View on/ })
  const details = async () => {
    const frame = await firstStatus(port)
    evidence.frames.push({ type: frame.type, details: frame.details, generation: frame.generation })
    return frame.details
  }
  const savedText = async () => {
    const text = await readFile(file, 'utf8')
    evidence.savedFiles.push(Object.keys(JSON.parse(text)).sort())
    return text
  }
  try {
    // Fresh install: off and disabled, with copy saying text leaves the Mac while it is on.
    await launch()
    await settings().click()
    await messages().scrollIntoViewIfNeeded()
    await expect(messages()).toHaveAttribute('aria-checked', 'false')
    await expect(messages()).toBeDisabled()
    await expect(
      page.getByText(/While this is on, conversation text leaves this Mac/)
    ).toBeVisible()
    await capture('fresh-install-off')
    await quit()

    // Saved ON: Remote View resumes, the switch does not.
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        enabled: true,
        ownerLogin: OWNER,
        hostName: HOST,
        port,
        sharedWorkspaces: [CWD],
        shareTitles: false
      })
    )
    await launch()
    await expect(label()).toHaveText('Remote View on')
    expect(await details()).toBe(false)
    await settings().click()
    await messages().scrollIntoViewIfNeeded()
    await expect(messages()).toHaveAttribute('aria-checked', 'false')
    await expect(messages()).toBeEnabled()

    // Keyboard on: focus stays, the label and the stream say so, the file does not change.
    const before = await savedText()
    await messages().focus()
    await page.keyboard.press('Space')
    await expect(messages()).toHaveAttribute('aria-checked', 'true')
    await expect(messages()).toBeFocused()
    await expect(page.getByText(/^Recent messages are shared until/)).toBeVisible()
    expect(await details()).toBe(true)
    await capture('switch-on')
    await page.keyboard.press('Escape')
    await expect(label()).toHaveText('Remote View on · messages shared')
    await capture('label-messages-shared')
    expect(await savedText()).toBe(before)
    expect(before).not.toMatch(/message|details/i)

    // Quit with it on and reopen: off again, and statuses carry `details: false` (A16).
    await quit()
    await launch()
    await expect(label()).toHaveText('Remote View on')
    expect(await details()).toBe(false)
    await settings().click()
    await messages().scrollIntoViewIfNeeded()
    await expect(messages()).toHaveAttribute('aria-checked', 'false')
    await capture('reopened-off')

    // Remote View off turns it off and disables it; on again keeps it off.
    await messages().click()
    await expect(messages()).toHaveAttribute('aria-checked', 'true')
    await remoteSwitch().click()
    await expect(remoteSwitch()).toHaveAttribute('aria-checked', 'false')
    await expect(messages()).toHaveAttribute('aria-checked', 'false')
    await expect(messages()).toBeDisabled()
    await capture('remote-off')
    await remoteSwitch().click()
    await expect(remoteSwitch()).toHaveAttribute('aria-checked', 'true')
    await expect(messages()).toHaveAttribute('aria-checked', 'false')
    expect(await details()).toBe(false)
    await remoteSwitch().click()
    await expect(remoteSwitch()).toHaveAttribute('aria-checked', 'false')
    await quit()

    // Settings that cannot be read: off and disabled.
    await writeFile(file, '{ not json')
    await launch()
    await settings().click()
    await expect(
      page.getByText("Couldn't load Remote View settings. Remote View stays off.")
    ).toBeVisible()
    await messages().scrollIntoViewIfNeeded()
    await expect(messages()).toHaveAttribute('aria-checked', 'false')
    await expect(messages()).toBeDisabled()
    await capture('load-failed-off')
    expect(errors).toEqual([])
    const requests = await application.evaluate(() => globalThis.agentpeekSmokeAudit)
    expect(requests.every((entry) => entry.ownFile)).toBe(true)
    await quit()
    await rm(file, { force: true })
  } catch (error) {
    evidence.failure = error.message
    if (page) await capture('failure').catch(() => undefined)
    throw error
  } finally {
    if (application) await application.close().catch(() => undefined)
    await stopProfile(fixture.userData)
    evidence.cleanup = { processes: profileProcesses(fixture.userData), errors }
    await writeFile(info.outputPath('evidence.json'), JSON.stringify(evidence, null, 2))
    await removeFixture(fixture.home)
  }
})
