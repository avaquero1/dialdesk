import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'contracts', include: ['tests/**/*.test.ts', 'packages/*/test/**/*.test.ts', 'services/*/test/**/*.test.ts', 'web/test/unit/**/*.test.ts'] } },
      { test: { name: 'web', include: ['web/test/*.test.ts'], testTimeout: 240_000, hookTimeout: 60_000, fileParallelism: false } },
      { test: { name: 'e2e', include: ['e2e/*.test.ts'], testTimeout: 60_000, hookTimeout: 120_000 } },
      // The same journey on the real services, only the model faked: `make e2e-real` (Compose, Docker, `make dev-secrets`).
      { test: { name: 'e2e-real', include: ['e2e/real/*.test.ts'], testTimeout: 120_000, hookTimeout: 240_000, fileParallelism: false } },
      // Meeting point 2 on the live pieces (it spends on Vultr models and reads the internet): `make e2e-live`.
      { test: { name: 'e2e-live', include: ['e2e/live/*.test.ts'], testTimeout: 180_000, hookTimeout: 300_000, fileParallelism: false } },
      // Real sandboxes on Docker: `make containment-local` (needs `make images`).
      { test: { name: 'containment', include: ['sandbox/test/**/*.test.ts'], testTimeout: 60_000, hookTimeout: 120_000 } },
    ],
  },
});
