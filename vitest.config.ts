import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'contracts', include: ['tests/**/*.test.ts', 'packages/*/test/**/*.test.ts', 'services/*/test/**/*.test.ts', 'web/test/unit/**/*.test.ts'] } },
      { test: { name: 'web', include: ['web/test/*.test.ts'], testTimeout: 240_000, hookTimeout: 60_000, fileParallelism: false } },
      { test: { name: 'e2e', include: ['e2e/**/*.test.ts'], testTimeout: 60_000, hookTimeout: 120_000 } },
      // Real sandboxes on Docker: `make containment-local` (needs `make images`).
      { test: { name: 'containment', include: ['sandbox/test/**/*.test.ts'], testTimeout: 60_000, hookTimeout: 120_000 } },
    ],
  },
});
