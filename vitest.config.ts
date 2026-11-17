import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          include: ['src/{core,main,preload,shared}/**/*.test.ts', 'scripts/fixture/*.test.mjs'],
          environment: 'node'
        }
      },
      {
        test: {
          name: 'renderer',
          include: ['src/renderer/**/*.test.{ts,tsx}'],
          environment: 'jsdom',
          setupFiles: ['src/renderer/test-setup.ts']
        }
      },
      {
        // The Remote View page (remote/web), in a browser-like environment like the renderer.
        test: {
          name: 'remote-web',
          include: ['remote/web/src/**/*.test.{ts,tsx}'],
          environment: 'jsdom'
        }
      },
      {
        // Checks on the page's sources that need Node.js, such as its import boundary.
        test: {
          name: 'remote-web-boundary',
          include: ['remote/web/*.test.ts'],
          environment: 'node'
        }
      }
    ]
  }
})
