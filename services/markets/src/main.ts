import { fileURLToPath } from 'node:url';
import { MARKETS } from '@app/contracts';
import { runService } from '@app/service-kit';
import { fake, fakeDepsFromEnv } from './fake.ts';
import { real } from './real.ts';

await runService({
  service: 'markets',
  api: MARKETS,
  fake: async () => fake(await fakeDepsFromEnv()),
  real: (cfg) => real(cfg, { keepList: true }),
  migrationsDir: fileURLToPath(new URL('../migrations', import.meta.url)),
});
