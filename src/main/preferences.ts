import { mkdir, open, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  DEFAULT_SOURCES,
  type SourcePreferences,
  isTheme,
  isZoomPercent,
  MAX_ZOOM,
  MIN_ZOOM,
  type Theme,
  type ZoomAction
} from '../shared/preferences'
import type { AgentTool } from '../core/tools'

/** App preferences are separate from session state and never contain tool data. */
export async function openPreferences(
  folder: string,
  applyTheme: (theme: Theme) => void,
  applyZoom: (percent: number) => void = () => undefined
) {
  const file = join(folder, 'preferences.json')
  const temporary = `${file}.tmp`
  let theme: Theme = 'system'
  let zoomPercent = 100
  let sources: SourcePreferences = { ...DEFAULT_SOURCES }
  try {
    const handle = await open(file, 'r')
    try {
      if ((await handle.stat()).size <= 4096) {
        const value: unknown = JSON.parse(await handle.readFile('utf8'))
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          const preferences = value as Record<string, unknown>
          if (preferences.version === 1) {
            if (isTheme(preferences.theme)) theme = preferences.theme
            if (isZoomPercent(preferences.zoomPercent)) zoomPercent = preferences.zoomPercent
            if (typeof preferences.sources === 'object' && preferences.sources !== null) {
              const saved = preferences.sources as Record<string, unknown>
              for (const tool of ['codex', 'claude'] as const)
                if (typeof saved[tool] === 'boolean') sources[tool] = saved[tool]
            }
          }
        }
      }
    } finally {
      await handle.close()
    }
  } catch {
    // Missing, invalid or unreadable preferences must not prevent the app from opening.
  }
  applyTheme(theme)
  applyZoom(zoomPercent)
  let pending = Promise.resolve()
  function save(
    change: () => { theme: Theme; zoomPercent: number; sources: SourcePreferences }
  ): Promise<void> {
    const saving = pending.then(async () => {
      const previous = { theme, zoomPercent, sources }
      const next = change()
      if (
        next.theme === theme &&
        next.zoomPercent === zoomPercent &&
        next.sources.codex === sources.codex &&
        next.sources.claude === sources.claude
      )
        return
      theme = next.theme
      zoomPercent = next.zoomPercent
      sources = next.sources
      if (theme !== previous.theme) applyTheme(theme)
      if (zoomPercent !== previous.zoomPercent) applyZoom(zoomPercent)
      try {
        await mkdir(folder, { recursive: true })
        await rm(temporary, { force: true })
        const handle = await open(temporary, 'wx', 0o600)
        try {
          await handle.writeFile(
            `${JSON.stringify({ version: 1, theme, zoomPercent, sources })}\n`,
            'utf8'
          )
          await handle.sync()
        } finally {
          await handle.close()
        }
        await rename(temporary, file)
      } catch {
        theme = previous.theme
        zoomPercent = previous.zoomPercent
        sources = previous.sources
        if (next.theme !== theme) applyTheme(theme)
        if (next.zoomPercent !== zoomPercent) applyZoom(zoomPercent)
        await rm(temporary, { force: true }).catch(() => undefined)
        throw new Error('Could not save preferences.')
      }
    })
    pending = saving.catch(() => undefined)
    return saving
  }
  return {
    async getTheme(this: void): Promise<Theme> {
      await pending
      return theme
    },
    setTheme(this: void, next: Theme): Promise<void> {
      return save(() => ({ theme: next, zoomPercent, sources }))
    },
    getSources(this: void): SourcePreferences {
      return { ...sources }
    },
    setSourceEnabled(this: void, tool: AgentTool, enabled: boolean): Promise<void> {
      return save(() => ({ theme, zoomPercent, sources: { ...sources, [tool]: enabled } }))
    },
    getZoom(this: void): number {
      return zoomPercent
    },
    changeZoom(this: void, action: ZoomAction): Promise<void> {
      return save(() => ({
        theme,
        sources,
        zoomPercent:
          action === 'reset'
            ? 100
            : Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoomPercent + (action === 'in' ? 10 : -10)))
      }))
    },
    flush: () => pending
  }
}

export type Preferences = Awaited<ReturnType<typeof openPreferences>>
