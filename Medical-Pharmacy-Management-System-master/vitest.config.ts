import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts so the UI build plugins are not loaded for tests.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // The legacy backend binds a fixed port (3000), so test files must not run in parallel.
    fileParallelism: false,
    pool: 'forks',
    testTimeout: 30000,
    hookTimeout: 90000,
    reporters: ['default'],
  },
});
