import { fileURLToPath } from 'node:url';
import { MODELS } from '@app/contracts';
import { runService } from '@app/service-kit';
import { fake, fakeDepsFromEnv } from './fake.ts';
import { real } from './real.ts';

await runService({
  service: 'models',
  api: MODELS,
  fake: async () => fake(await fakeDepsFromEnv()),
  real,
  migrationsDir: fileURLToPath(new URL('../migrations', import.meta.url)),
});
