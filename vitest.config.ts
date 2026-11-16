import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // SQLite is a native Node builtin; run tests in forks so each file has a clean process.
    pool: 'forks',
    testTimeout: 15_000,
  },
});
