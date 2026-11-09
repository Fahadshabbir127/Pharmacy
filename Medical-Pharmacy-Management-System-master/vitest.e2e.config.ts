import { defineConfig } from 'vitest/config';

// Desktop end-to-end tests (real Electron app). Run with `npm run test:e2e` after `npm run build:desktop`.
// On Linux they need a display: the script wraps them in xvfb-run.
export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.e2e.ts'],
    environment: 'node',
    fileParallelism: false,
    pool: 'forks',
    testTimeout: 120_000,
    hookTimeout: 180_000,
    reporters: ['default'],
  },
});
