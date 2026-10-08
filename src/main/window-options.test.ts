import { describe, expect, it } from 'vitest'
import { DEFAULT_WINDOW_SIZE, MIN_WINDOW_SIZE, mainWindowOptions } from './window-options'

describe('mainWindowOptions', () => {
  const options = mainWindowOptions('/app/out/preload/index.js')

  it('isolates and sandboxes the renderer without Node.js', () => {
    expect(options.webPreferences).toMatchObject({
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false
    })
  })

  it('loads the given preload script', () => {
    expect(options.webPreferences?.preload).toBe('/app/out/preload/index.js')
  })

  it('opens hidden at the default size and keeps the minimum size', () => {
    expect(options).toMatchObject({
      show: false,
      width: DEFAULT_WINDOW_SIZE.width,
      height: DEFAULT_WINDOW_SIZE.height,
      minWidth: MIN_WINDOW_SIZE.width,
      minHeight: MIN_WINDOW_SIZE.height
    })
  })
})
