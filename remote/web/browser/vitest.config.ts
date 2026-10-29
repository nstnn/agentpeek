import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Browser-level checks of the Remote View page (TASK-017): the built page in headless Chrome,
// through a simulated Serve in front of the real listener. Kept out of `npm test` because they
// need the viewer build and Chrome; `npm run test:remote-browser` builds the page first.
export default defineConfig({
  root: fileURLToPath(new URL('../../..', import.meta.url)),
  test: {
    name: 'remote-web-browser',
    include: ['remote/web/browser/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
})
