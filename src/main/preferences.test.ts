import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openPreferences } from './preferences'

const folders: string[] = []
async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), 'agentpeek-preferences-'))
  folders.push(folder)
  return folder
}
afterEach(async () => {
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })))
})

describe('appearance preferences', () => {
  it('defaults to System without creating a preference file, persists choices and restores on reopen', async () => {
    const folder = await fixture()
    const state = join(folder, 'state.json')
    await writeFile(state, 'synthetic session state')
    const apply = vi.fn()
    const preferences = await openPreferences(folder, apply)
    expect(apply).toHaveBeenCalledWith('system')
    await expect(readFile(join(folder, 'preferences.json'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
    for (const theme of ['dark', 'light', 'system'] as const) {
      await preferences.setTheme(theme)
      const reopenedApply = vi.fn()
      const reopened = await openPreferences(folder, reopenedApply)
      expect(await reopened.getTheme()).toBe(theme)
      expect(reopenedApply).toHaveBeenCalledWith(theme)
      expect(JSON.parse(await readFile(join(folder, 'preferences.json'), 'utf8'))).toEqual({
        version: 1,
        theme
      })
    }
    expect(await readFile(state, 'utf8')).toBe('synthetic session state')
  })
  it.each([
    '{',
    '{"version":1,"theme":"auto"}',
    '{"version":2,"theme":"dark"}',
    '[]',
    'x'.repeat(4097)
  ])('opens safely with invalid preferences (case %#)', async (contents) => {
    const folder = await fixture()
    await writeFile(join(folder, 'preferences.json'), contents)
    const preferences = await openPreferences(folder, vi.fn())
    expect(await preferences.getTheme()).toBe('system')
    expect(await readFile(join(folder, 'preferences.json'), 'utf8')).toBe(contents)
  })
  it('serializes changes and lets shutdown and a reopened dialog await the final save', async () => {
    const folder = await fixture()
    const preferences = await openPreferences(folder, vi.fn())
    const first = preferences.setTheme('dark')
    const second = preferences.setTheme('light')
    const current = preferences.getTheme()
    await preferences.flush()
    await Promise.all([first, second])
    expect(await current).toBe('light')
    expect(await (await openPreferences(folder, vi.fn())).getTheme()).toBe('light')
  })
  it('restores the previous appearance after a failed save, preserves the old file and permits retry', async () => {
    const folder = await fixture()
    const apply = vi.fn()
    const preferences = await openPreferences(folder, apply)
    await preferences.setTheme('light')
    const file = join(folder, 'preferences.json')
    const before = await readFile(file, 'utf8')
    await mkdir(`${file}.tmp`)
    await expect(preferences.setTheme('dark')).rejects.toThrow('Could not save preferences.')
    expect(apply.mock.calls.slice(-2)).toEqual([['dark'], ['light']])
    expect(await preferences.getTheme()).toBe('light')
    expect(await readFile(file, 'utf8')).toBe(before)
    await rm(`${file}.tmp`, { recursive: true })
    await preferences.setTheme('dark')
    expect(await (await openPreferences(folder, vi.fn())).getTheme()).toBe('dark')
  })
})
