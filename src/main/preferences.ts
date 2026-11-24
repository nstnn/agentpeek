import { mkdir, open, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  DEFAULT_SESSION_RANGE,
  DEFAULT_SOURCES,
  type SessionRange,
  type SourcePreferences,
  isSessionRange,
  isTheme,
  isZoomPercent,
  MAX_ZOOM,
  MIN_ZOOM,
  type Theme,
  type ZoomAction
} from '../shared/preferences'
import { AGENT_TOOLS, type AgentTool } from '../core/tools'

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
  let sessionRange: SessionRange = { ...DEFAULT_SESSION_RANGE }
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
              // A file saved before a source existed keeps that source's default.
              for (const tool of AGENT_TOOLS)
                if (typeof saved[tool] === 'boolean') sources[tool] = saved[tool]
            }
            if (isSessionRange(preferences.sessionRange))
              sessionRange = {
                days: preferences.sessionRange.days,
                maxPerTool: preferences.sessionRange.maxPerTool
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
  type Saved = {
    theme: Theme
    zoomPercent: number
    sources: SourcePreferences
    sessionRange: SessionRange
  }
  const current = (): Saved => ({ theme, zoomPercent, sources, sessionRange })
  function save(change: (previous: Saved) => Saved): Promise<void> {
    const saving = pending.then(async () => {
      const previous = current()
      const next = change(previous)
      if (
        next.theme === theme &&
        next.zoomPercent === zoomPercent &&
        AGENT_TOOLS.every((tool) => next.sources[tool] === sources[tool]) &&
        next.sessionRange.days === sessionRange.days &&
        next.sessionRange.maxPerTool === sessionRange.maxPerTool
      )
        return
      theme = next.theme
      zoomPercent = next.zoomPercent
      sources = next.sources
      sessionRange = next.sessionRange
      if (theme !== previous.theme) applyTheme(theme)
      if (zoomPercent !== previous.zoomPercent) applyZoom(zoomPercent)
      try {
        await mkdir(folder, { recursive: true })
        await rm(temporary, { force: true })
        const handle = await open(temporary, 'wx', 0o600)
        try {
          await handle.writeFile(
            `${JSON.stringify({ version: 1, theme, zoomPercent, sources, sessionRange })}\n`,
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
        sessionRange = previous.sessionRange
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
      return save((saved) => ({ ...saved, theme: next }))
    },
    getSources(this: void): SourcePreferences {
      return { ...sources }
    },
    setSourceEnabled(this: void, tool: AgentTool, enabled: boolean): Promise<void> {
      return save((saved) => ({ ...saved, sources: { ...saved.sources, [tool]: enabled } }))
    },
    getSessionRange(this: void): SessionRange {
      return { ...sessionRange }
    },
    setSessionRange(this: void, next: SessionRange): Promise<void> {
      return save((saved) => ({ ...saved, sessionRange: { ...next } }))
    },
    getZoom(this: void): number {
      return zoomPercent
    },
    changeZoom(this: void, action: ZoomAction): Promise<void> {
      return save((saved) => ({
        ...saved,
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
