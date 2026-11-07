import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'contracts', include: ['tests/**/*.test.ts', 'packages/*/test/**/*.test.ts', 'services/*/test/**/*.test.ts'] } },
      { test: { name: 'e2e', include: ['e2e/**/*.test.ts'], testTimeout: 60_000, hookTimeout: 120_000 } },
    ],
  },
});
