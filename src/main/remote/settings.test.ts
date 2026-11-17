import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  checkConnection,
  DEFAULT_REMOTE_SETTINGS,
  loadRemoteSettings,
  REMOTE_SETTINGS_FILE,
  saveRemoteSettings
} from './settings'

const folders: string[] = []
async function folder() {
  const path = await mkdtemp(join(tmpdir(), 'agentpeek-remote-settings-'))
  folders.push(path)
  return path
}
afterEach(async () => {
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const valid = { ownerLogin: 'owner@example.com', hostName: 'mac.tailnet.ts.net', port: 47613 }
const SHARED = '/Users/synthetic/projects/app'
const sharing = { sharedWorkspaces: [SHARED], shareTitles: true }

describe('connection check', () => {
  it('trims the login, lowercases the Mac address and accepts ports 1024 to 65535', () => {
    expect(
      checkConnection({
        ownerLogin: ' owner@github ',
        hostName: ' Mac.Tailnet.TS.net ',
        port: 1024
      })
    ).toEqual({
      ok: true,
      connection: { ownerLogin: 'owner@github', hostName: 'mac.tailnet.ts.net', port: 1024 }
    })
    expect(checkConnection({ ...valid, port: 65535 }).ok).toBe(true)
  })

  it('names every invalid field', () => {
    expect(checkConnection({ ownerLogin: '', hostName: '', port: 80 })).toEqual({
      ok: false,
      invalid: ['ownerLogin', 'hostName', 'port']
    })
    for (const ownerLogin of ['owner', 'a@b,c@d', 'a b@c', 'a@b@c', 'é@example.com', 7]) {
      expect(checkConnection({ ...valid, ownerLogin })).toEqual({
        ok: false,
        invalid: ['ownerLogin']
      })
    }
    for (const hostName of [
      'mac.ts.net',
      'mac.tailnet.ts.net:443',
      'https://mac.tailnet.ts.net',
      'mac.tailnet.example.com'
    ]) {
      expect(checkConnection({ ...valid, hostName })).toEqual({ ok: false, invalid: ['hostName'] })
    }
    for (const port of [0, 1023, 65536, 47613.5, '47613']) {
      expect(checkConnection({ ...valid, port })).toEqual({ ok: false, invalid: ['port'] })
    }
  })
})

describe('remote settings file', () => {
  it('is off and unconfigured when missing', async () => {
    expect(await loadRemoteSettings(await folder())).toEqual({
      ok: true,
      settings: DEFAULT_REMOTE_SETTINGS
    })
  })

  it('saves atomically for the user only and loads back the same settings', async () => {
    const dir = await folder()
    await saveRemoteSettings(dir, { enabled: true, ...valid, ...sharing })
    const file = join(dir, REMOTE_SETTINGS_FILE)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      version: 1,
      enabled: true,
      ...valid,
      ...sharing
    })
    expect(await loadRemoteSettings(dir)).toEqual({
      ok: true,
      settings: { enabled: true, ...valid, ...sharing }
    })
  })

  it('shares nothing when a file saved before sharing existed has no sharing fields', async () => {
    const dir = await folder()
    await writeFile(
      join(dir, REMOTE_SETTINGS_FILE),
      JSON.stringify({ version: 1, enabled: true, ...valid })
    )
    expect(await loadRemoteSettings(dir)).toEqual({
      ok: true,
      settings: { enabled: true, ...valid, sharedWorkspaces: [], shareTitles: false }
    })
  })

  it('holds 50 folders of the longest path, and fails to load a 51st', async () => {
    const dir = await folder()
    const long = (n: number) => `/${String(n).padStart(2, '0')}${'"'.repeat(1021)}`
    const fifty = Array.from({ length: 50 }, (_, n) => long(n))
    await saveRemoteSettings(dir, {
      enabled: true,
      ...valid,
      sharedWorkspaces: fifty,
      shareTitles: false
    })
    expect(await loadRemoteSettings(dir)).toMatchObject({
      ok: true,
      settings: { sharedWorkspaces: fifty }
    })
    await saveRemoteSettings(dir, {
      enabled: true,
      ...valid,
      sharedWorkspaces: [...fifty, long(50)],
      shareTitles: false
    })
    expect(await loadRemoteSettings(dir)).toEqual({ ok: false })
  })

  it('fails to load, never guesses, when the file is not exactly valid settings', async () => {
    const dir = await folder()
    const file = join(dir, REMOTE_SETTINGS_FILE)
    const good = { version: 1, enabled: true, ...valid, ...sharing }
    for (const content of [
      'not json',
      '[]',
      JSON.stringify({ ...good, version: 2 }),
      JSON.stringify({ ...good, enabled: 'yes' }),
      JSON.stringify({ ...good, ownerLogin: ' owner@example.com' }),
      JSON.stringify({ ...good, hostName: 'MAC.tailnet.ts.net' }),
      JSON.stringify({ ...good, port: 80 }),
      JSON.stringify({ ...good, sharedWorkspaces: SHARED }),
      JSON.stringify({ ...good, sharedWorkspaces: null }),
      JSON.stringify({ ...good, sharedWorkspaces: [`${SHARED}/`] }),
      JSON.stringify({ ...good, sharedWorkspaces: ['projects/app'] }),
      JSON.stringify({ ...good, sharedWorkspaces: ['/'] }),
      JSON.stringify({ ...good, sharedWorkspaces: [`${SHARED}\n`] }),
      JSON.stringify({ ...good, sharedWorkspaces: [SHARED, SHARED] }),
      JSON.stringify({ ...good, shareTitles: 'yes' }),
      JSON.stringify({ ...good, padding: 'x'.repeat(128 * 1024) })
    ]) {
      await writeFile(file, content)
      expect(await loadRemoteSettings(dir), content.slice(0, 40)).toEqual({ ok: false })
    }
    await writeFile(file, JSON.stringify({ ...good, ownerLogin: '', hostName: '' }))
    expect(await loadRemoteSettings(dir)).toEqual({
      ok: true,
      settings: { enabled: true, ownerLogin: '', hostName: '', port: 47613, ...sharing }
    })
  })

  it('throws a fixed error when it cannot save', async () => {
    const dir = await folder()
    const blocked = join(dir, 'file')
    await writeFile(blocked, '')
    await expect(saveRemoteSettings(blocked, DEFAULT_REMOTE_SETTINGS)).rejects.toThrow(
      'Could not save Remote View settings.'
    )
  })
})
