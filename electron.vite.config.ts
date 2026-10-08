import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

// electron-vite builds three bundles: the main process (src/main), the preload script
// (src/preload), and the renderer (src/renderer). Each one's entry is its index file.
export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    plugins: [react()]
  }
})
