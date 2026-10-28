import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// A first launch maximizes to the display, so layout breakpoints would depend on the
// machine. Start from the unmaximized default window instead; the app fits it on screen.
export async function seedDefaultWindow(userData) {
  const state = {
    version: 1,
    bounds: { x: 0, y: 0, width: 1280, height: 800 },
    maximized: false,
    fullScreen: false
  }
  await writeFile(join(userData, 'window-state.json'), `${JSON.stringify(state)}\n`)
}
