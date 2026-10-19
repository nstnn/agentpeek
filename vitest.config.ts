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
      }
    ]
  }
})
