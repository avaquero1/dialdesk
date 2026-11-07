import { fileURLToPath } from 'node:url';

/**
 * audit's tables belong to this NOLOGIN role, not to svc_audit (deploy/db-init.sql). svc_audit may only SELECT and
 * INSERT, so even the audit service can't change, delete, truncate or alter a row of the log.
 */
export const AUDIT_OWNER = 'audit_owner';
export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
