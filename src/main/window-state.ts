import { randomUUID } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import type { Rectangle } from 'electron'
import { MIN_WINDOW_SIZE } from './window-options'

export interface WindowState {
  bounds: Rectangle
  maximized: boolean
  fullScreen: boolean
}

function isBounds(value: unknown): value is Rectangle {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const bounds = value as Record<string, unknown>
  return (
    ['x', 'y', 'width', 'height'].every((key) => {
      const coordinate = bounds[key]
      return (
        typeof coordinate === 'number' &&
        Number.isSafeInteger(coordinate) &&
        Math.abs(coordinate) <= 100_000
      )
    }) &&
    typeof bounds.width === 'number' &&
    bounds.width > 0 &&
    typeof bounds.height === 'number' &&
    bounds.height > 0
  )
}

/** Only app-owned geometry is persisted; this file never contains session data. */
export function readWindowState(folder: string): WindowState | null {
  try {
    const handle = openSync(join(folder, 'window-state.json'), 'r')
    try {
      if (fstatSync(handle).size > 4096) return null
      const value: unknown = JSON.parse(readFileSync(handle, 'utf8'))
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
      const state = value as Record<string, unknown>
      const bounds = state.bounds
      if (
        state.version !== 1 ||
        typeof state.maximized !== 'boolean' ||
        typeof state.fullScreen !== 'boolean' ||
        !isBounds(bounds)
      )
        return null
      return {
        bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
        maximized: state.maximized,
        fullScreen: state.fullScreen
      }
    } finally {
      closeSync(handle)
    }
  } catch {
    // Missing, malformed or unreadable geometry must not prevent startup.
    return null
  }
}

/** A removed monitor or smaller work area must not leave the title bar off screen. */
export function fitWindowBounds(bounds: Rectangle, workArea: Rectangle): Rectangle {
  const width = Math.min(workArea.width, Math.max(MIN_WINDOW_SIZE.width, bounds.width))
  const height = Math.min(workArea.height, Math.max(MIN_WINDOW_SIZE.height, bounds.height))
  return {
    x: Math.max(workArea.x, Math.min(bounds.x, workArea.x + workArea.width - width)),
    y: Math.max(workArea.y, Math.min(bounds.y, workArea.y + workArea.height - height)),
    width,
    height
  }
}

/** Save once at normal close/quit, atomically, without delaying app shutdown. */
export function saveWindowState(folder: string, state: WindowState): boolean {
  const temporary = join(folder, `window-state-${randomUUID()}.tmp`)
  try {
    mkdirSync(folder, { recursive: true })
    const handle = openSync(temporary, 'wx', 0o600)
    try {
      writeFileSync(handle, `${JSON.stringify({ version: 1, ...state })}\n`, 'utf8')
      fsyncSync(handle)
    } finally {
      closeSync(handle)
    }
    renameSync(temporary, join(folder, 'window-state.json'))
    return true
  } catch {
    // Preserve the last successful geometry if storage is unavailable.
    try {
      rmSync(temporary, { force: true })
    } catch {
      // Cleanup failure must not interrupt quitting either.
    }
    return false
  }
}
