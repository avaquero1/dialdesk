import { fileURLToPath } from 'node:url';
import { RUNNER } from '@app/contracts';
import { runService } from '@app/service-kit';
import { fake, fakeDepsFromEnv } from './fake.ts';
import { real } from './real.ts';

await runService({
  service: 'runner',
  api: RUNNER,
  fake: async () => fake(await fakeDepsFromEnv()),
  real,
  migrationsDir: fileURLToPath(new URL('../migrations', import.meta.url)),
});
