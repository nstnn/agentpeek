import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fitWindowBounds, readWindowState, saveWindowState } from './window-state'

let folder: string
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'agentpeek-window-state-'))
})
afterEach(() => rmSync(folder, { recursive: true, force: true }))

const state = {
  bounds: { x: -1200, y: 60, width: 1000, height: 700 },
  maximized: false,
  fullScreen: false
}

describe('window state', () => {
  it('defaults without creating a file and round-trips geometry without touching other app state', () => {
    expect(readWindowState(folder)).toBeNull()
    expect(readdirSync(folder)).toEqual([])
    writeFileSync(join(folder, 'preferences.json'), '{"version":1,"theme":"dark"}')
    writeFileSync(join(folder, 'state.json'), 'synthetic session state')
    for (const mode of [state, { ...state, maximized: true }, { ...state, fullScreen: true }]) {
      expect(saveWindowState(folder, mode)).toBe(true)
      expect(readWindowState(folder)).toEqual(mode)
    }
    expect(readFileSync(join(folder, 'preferences.json'), 'utf8')).toBe(
      '{"version":1,"theme":"dark"}'
    )
    expect(readFileSync(join(folder, 'state.json'), 'utf8')).toBe('synthetic session state')
    expect(readdirSync(folder).sort()).toEqual([
      'preferences.json',
      'state.json',
      'window-state.json'
    ])
  })

  it.each([
    '{',
    'null',
    '[]',
    'x'.repeat(4097),
    JSON.stringify({ version: 2, ...state }),
    JSON.stringify({ version: 1, ...state, maximized: 'true' }),
    JSON.stringify({ version: 1, ...state, fullScreen: 1 }),
    ...[0, -1, 1.5, 100_001, '1000', null].map((width) =>
      JSON.stringify({ version: 1, ...state, bounds: { ...state.bounds, width } })
    )
  ])('ignores invalid saved geometry without changing the file (case %#)', (contents) => {
    const file = join(folder, 'window-state.json')
    writeFileSync(file, contents)
    expect(readWindowState(folder)).toBeNull()
    expect(readFileSync(file, 'utf8')).toBe(contents)
  })

  it('does not interrupt shutdown or leave temporary files when saving fails, and can retry', () => {
    const file = join(folder, 'window-state.json')
    mkdirSync(file)
    expect(saveWindowState(folder, state)).toBe(false)
    expect(readdirSync(folder)).toEqual(['window-state.json'])
    rmSync(file, { recursive: true })
    expect(saveWindowState(folder, state)).toBe(true)
    expect(readWindowState(folder)).toEqual(state)
  })
})

describe('restoring on available displays', () => {
  it('preserves a valid position on a display with negative coordinates', () => {
    expect(fitWindowBounds(state.bounds, { x: -1600, y: 25, width: 1600, height: 1000 })).toEqual(
      state.bounds
    )
  })

  it('fits a disconnected display position and an oversized window into the current work area', () => {
    expect(
      fitWindowBounds(
        { x: -2000, y: -500, width: 1800, height: 1200 },
        { x: 0, y: 25, width: 1440, height: 850 }
      )
    ).toEqual({ x: 0, y: 25, width: 1440, height: 850 })
    expect(
      fitWindowBounds(
        { x: 3000, y: 2000, width: 100, height: 200 },
        { x: 0, y: 25, width: 1440, height: 850 }
      )
    ).toEqual({ x: 680, y: 395, width: 760, height: 480 })
  })
})
