import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindowConstructorOptions } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMainWindow } from './window'
import { readWindowState, saveWindowState } from './window-state'

const mocks = vi.hoisted(() => ({
  getPath: vi.fn(),
  BrowserWindow: vi.fn(),
  getPrimaryDisplay: vi.fn(),
  getDisplayMatching: vi.fn()
}))
vi.mock('electron', () => ({
  app: { getPath: mocks.getPath, isPackaged: true },
  BrowserWindow: mocks.BrowserWindow,
  screen: {
    getPrimaryDisplay: mocks.getPrimaryDisplay,
    getDisplayMatching: mocks.getDisplayMatching
  }
}))

function fakeWindow(options: BrowserWindowConstructorOptions) {
  let maximized = false
  let fullScreen = false
  return Object.assign(new EventEmitter(), {
    options,
    show: vi.fn(),
    maximize: vi.fn(() => {
      maximized = true
    }),
    setFullScreen: vi.fn((value: boolean) => {
      fullScreen = value
    }),
    isMaximized: vi.fn(() => maximized),
    isFullScreen: vi.fn(() => fullScreen),
    getNormalBounds: vi.fn(() => ({
      x: options.x!,
      y: options.y!,
      width: options.width!,
      height: options.height!
    })),
    loadURL: vi.fn().mockResolvedValue(undefined)
  })
}
function latest() {
  return mocks.BrowserWindow.mock.results.at(-1)!.value as ReturnType<typeof fakeWindow>
}

let folder: string
beforeEach(() => {
  vi.clearAllMocks()
  folder = mkdtempSync(join(tmpdir(), 'agentpeek-window-'))
  mocks.getPath.mockReturnValue(folder)
  const display = { workArea: { x: 0, y: 25, width: 1440, height: 850 } }
  mocks.getPrimaryDisplay.mockReturnValue(display)
  mocks.getDisplayMatching.mockReturnValue(display)
  mocks.BrowserWindow.mockImplementation(function (options: BrowserWindowConstructorOptions) {
    return fakeWindow(options)
  })
})
afterEach(() => rmSync(folder, { recursive: true, force: true }))

describe('main window startup and restoration', () => {
  it('maximizes a first launch only when content is ready and does not enter Full Screen', () => {
    createMainWindow(120)
    const window = latest()
    expect(window.options.show).toBe(false)
    expect(window.options.webPreferences).toMatchObject({ zoomFactor: 1.2, sandbox: true })
    expect(window.maximize).not.toHaveBeenCalled()
    expect(window.show).not.toHaveBeenCalled()
    window.emit('ready-to-show')
    expect(window.maximize).toHaveBeenCalledOnce()
    expect(window.show).toHaveBeenCalledOnce()
    expect(window.setFullScreen).not.toHaveBeenCalled()
    window.emit('close')
    expect(readWindowState(folder)).toEqual({
      bounds: { x: 80, y: 50, width: 1280, height: 800 },
      maximized: true,
      fullScreen: false
    })
  })

  it('remembers a resized and moved window across close and a fresh window creation', () => {
    createMainWindow()
    const first = latest()
    first.emit('ready-to-show')
    first.isMaximized.mockReturnValue(false)
    first.getNormalBounds.mockReturnValue({ x: 120, y: 90, width: 950, height: 650 })
    first.emit('close')
    createMainWindow()
    const second = latest()
    expect(second.options).toMatchObject({ x: 120, y: 90, width: 950, height: 650 })
    second.emit('ready-to-show')
    expect(second.maximize).not.toHaveBeenCalled()
    expect(second.setFullScreen).not.toHaveBeenCalled()
    expect(second.show).toHaveBeenCalledOnce()
  })

  it.each([
    { maximized: true, fullScreen: false },
    { maximized: false, fullScreen: true }
  ])('restores saved mode %j and normal geometry rather than full display bounds', (mode) => {
    const bounds = { x: 50, y: 70, width: 1000, height: 700 }
    saveWindowState(folder, { bounds, ...mode })
    createMainWindow()
    const window = latest()
    expect(window.options).toMatchObject(bounds)
    window.emit('ready-to-show')
    expect(window.maximize).toHaveBeenCalledTimes(Number(mode.maximized))
    if (mode.fullScreen) {
      expect(window.setFullScreen).toHaveBeenCalledWith(true)
      expect(window.show.mock.invocationCallOrder[0]!).toBeLessThan(
        window.setFullScreen.mock.invocationCallOrder[0]!
      )
    } else expect(window.setFullScreen).not.toHaveBeenCalled()
    window.emit('close')
    expect(readWindowState(folder)).toEqual({ bounds, ...mode })
  })

  it('returns a window from a disconnected screen to the available work area', () => {
    saveWindowState(folder, {
      bounds: { x: -1800, y: 1000, width: 1600, height: 1000 },
      maximized: false,
      fullScreen: false
    })
    createMainWindow()
    expect(mocks.getDisplayMatching).toHaveBeenCalledWith({
      x: -1800,
      y: 1000,
      width: 1600,
      height: 1000
    })
    expect(latest().options).toMatchObject({ x: 0, y: 25, width: 1440, height: 850 })
  })
})
