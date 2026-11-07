/**
 * Applies audit's migrations as audit_owner: `npm run migrate -w services/audit`, run by the deploy before audit starts.
 *
 *   AUDIT_MIGRATE_DATABASE_URL   an admin login that may SET ROLE audit_owner (deploy/db-init.sql grants that to the
 *                                admin that ran it). Only the deploy step has it, never the audit container's env.
 *
 * audit itself never migrates: at start it checks that nothing is pending, and refuses to start if something is.
 */
import { createLogger, migrate } from '@app/service-kit';
import { AUDIT_OWNER, MIGRATIONS_DIR } from './migrations.ts';

const log = createLogger('audit');
const databaseUrl = process.env.AUDIT_MIGRATE_DATABASE_URL;
if (!databaseUrl) {
  log.error('set AUDIT_MIGRATE_DATABASE_URL to an admin login that may SET ROLE audit_owner');
  process.exit(2);
}
const applied = await migrate({ databaseUrl, schema: 'audit', dir: MIGRATIONS_DIR, log, role: AUDIT_OWNER });
log.info({ applied: applied.length, role: AUDIT_OWNER }, 'audit migrations up to date');
