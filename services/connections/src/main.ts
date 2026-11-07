import { fileURLToPath } from 'node:url';
import { CONNECTIONS } from '@app/contracts';
import { runService } from '@app/service-kit';
import { fake, fakeDepsFromEnv } from './fake.ts';
import { real } from './real.ts';

await runService({
  service: 'connections',
  api: CONNECTIONS,
  fake: async () => fake(await fakeDepsFromEnv()),
  real,
  migrationsDir: fileURLToPath(new URL('../migrations', import.meta.url)),
});
