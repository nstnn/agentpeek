import { mkdir, open, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { isTheme, type Theme } from '../shared/preferences'

/** App preferences are separate from session state and never contain tool data. */
export async function openPreferences(folder: string, applyTheme: (theme: Theme) => void) {
  const file = join(folder, 'preferences.json')
  const temporary = `${file}.tmp`
  let theme: Theme = 'system'
  try {
    const handle = await open(file, 'r')
    try {
      if ((await handle.stat()).size <= 4096) {
        const value: unknown = JSON.parse(await handle.readFile('utf8'))
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          const preferences = value as Record<string, unknown>
          if (preferences.version === 1 && isTheme(preferences.theme)) theme = preferences.theme
        }
      }
    } finally {
      await handle.close()
    }
  } catch {
    // Missing, invalid or unreadable preferences must not prevent the app from opening.
  }
  applyTheme(theme)
  let pending = Promise.resolve()
  return {
    async getTheme(this: void): Promise<Theme> {
      await pending
      return theme
    },
    setTheme(this: void, next: Theme): Promise<void> {
      const save = pending.then(async () => {
        const previous = theme
        applyTheme(next)
        try {
          await mkdir(folder, { recursive: true })
          await rm(temporary, { force: true })
          const handle = await open(temporary, 'wx', 0o600)
          try {
            await handle.writeFile(`${JSON.stringify({ version: 1, theme: next })}\n`, 'utf8')
            await handle.sync()
          } finally {
            await handle.close()
          }
          await rename(temporary, file)
          theme = next
        } catch {
          applyTheme(previous)
          await rm(temporary, { force: true }).catch(() => undefined)
          throw new Error('Could not save preferences.')
        }
      })
      pending = save.catch(() => undefined)
      return save
    },
    flush: () => pending
  }
}

export type Preferences = Awaited<ReturnType<typeof openPreferences>>
