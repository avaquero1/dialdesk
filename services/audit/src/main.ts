import { AUDIT } from '@app/contracts';
import { runService } from '@app/service-kit';
import { fake, fakeDepsFromEnv } from './fake.ts';
import { AUDIT_OWNER, MIGRATIONS_DIR } from './migrations.ts';
import { real } from './real.ts';

await runService({
  service: 'audit',
  api: AUDIT,
  fake: async () => fake(await fakeDepsFromEnv()),
  real,
  migrationsDir: MIGRATIONS_DIR,
  // svc_audit can't create tables: the deploy applies these as audit_owner (src/migrate.ts), audit only checks them.
  migrationsOwner: AUDIT_OWNER,
});
