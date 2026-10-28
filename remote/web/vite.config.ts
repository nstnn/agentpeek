import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The Remote View page is its own Vite build, separate from electron-vite's three Electron bundles,
// so no renderer or preload code can end up in it. The main process serves out/remote-web (TASK-014).
const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  root,
  base: '/',
  cacheDir: fileURLToPath(new URL('../../node_modules/.vite/remote-web', import.meta.url)),
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL('../../out/remote-web', import.meta.url)),
    emptyOutDir: true,
    // Only hashed .js and .css files under assets/, the paths the listener serves.
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false }
  }
})
