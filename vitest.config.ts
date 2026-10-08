import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // These tests run in plain Node.js. Renderer tests will need a separate project with a DOM.
    include: ['src/{core,main,preload,shared}/**/*.test.ts'],
    environment: 'node'
  }
})
