import { fileURLToPath } from 'node:url';
import { MODELS } from '@app/contracts';
import { busFromConfig, runService } from '@app/service-kit';
import { fake, fakeDepsFromEnv } from './fake.ts';
import { real } from './real.ts';

await runService({
  service: 'models',
  api: MODELS,
  fake: async () => fake(await fakeDepsFromEnv()),
  // every call is logged as model.call on log:actions (ids, a prompt hash and sizes), so audit sees the spend per role
  real: (cfg) => real(cfg, { bus: busFromConfig('models', cfg) }),
  migrationsDir: fileURLToPath(new URL('../migrations', import.meta.url)),
});
