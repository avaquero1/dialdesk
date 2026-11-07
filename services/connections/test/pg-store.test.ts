/**
 * The Postgres store, against a real database. Runs only when CONNECTIONS_TEST_DATABASE_URL is set (a throwaway
 * database: it creates schema "connections_test" and drops it after).
 */
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { createLogger, migrate } from '@app/service-kit';
import { PgStore, type Row } from '../src/store.ts';
import { openVault } from '../src/vault.ts';

const url = process.env.CONNECTIONS_TEST_DATABASE_URL;
const SCHEMA = 'connections_test';

describe.skipIf(!url)('connections: the Postgres store', () => {
  const admin = url ? postgres(url, { max: 1, onnotice: () => {} }) : null;
  afterAll(async () => {
    await admin?.unsafe(`drop schema if exists ${SCHEMA} cascade`);
    await admin?.end();
  });

  it('migrates, stores only ciphertext, keeps consent and numbers, and deletes both on remove', async () => {
    await admin!.unsafe(`drop schema if exists ${SCHEMA} cascade; create schema ${SCHEMA}`);
    const applied = await migrate({ databaseUrl: url!, schema: SCHEMA, dir: fileURLToPath(new URL('../migrations', import.meta.url)), log: createLogger('connections', 'silent') });
    expect(applied).toEqual(['0001_init.sql', '0002_connections.sql']);
    const s = new PgStore(url!, SCHEMA);
    const v = await openVault(randomBytes(32));
    const pem = '-----BEGIN PRIVATE KEY-----\nnot a real key\n-----END PRIVATE KEY-----\n';
    const row: Row = {
      conn: {
        connection_id: 'con_pgtest0001',
        account_id: 'acc_test0001',
        exchange: 'kalshi',
        label: 'key-1',
        scope: 'read',
        scope_verified: true,
        checked_at: '2026-11-07T12:00:00.000Z',
        share_numbers: false,
        public_data: false,
      },
      env: 'demo',
      key_id: 'key-1',
      key_type: 'ed25519',
      key_blob: v.encrypt(pem, 'con_pgtest0001'),
      key_fingerprint: 'a'.repeat(64),
      wallet: null,
      scopes: ['read'],
    };
    await s.insert(row);
    const got = (await s.get('con_pgtest0001'))!;
    expect(got.conn).toEqual(row.conn);
    expect(v.decrypt(got.key_blob!, 'con_pgtest0001')).toBe(pem);
    const [raw] = await admin!.unsafe(`select encode(key_blob, 'escape') as b from ${SCHEMA}.connections`);
    expect(String(raw!.b)).not.toContain('PRIVATE KEY');
    // a Kalshi row without a key is refused by the table itself
    await expect(s.insert({ ...row, conn: { ...row.conn, connection_id: 'con_pgtest0002' }, key_blob: null })).rejects.toThrow();

    expect(await s.shared()).toEqual([]);
    await s.setConsent('con_pgtest0001', true);
    expect(await s.shared()).toEqual([{ connection_id: 'con_pgtest0001', account_id: 'acc_test0001' }]);
    const n = { connection_id: 'con_pgtest0001', balance_cents: 124018, positions: [{ market_id: 'kalshi:KXA-1', side: 'yes' as const, count: 2, avg_price_cents: 40 }], as_of: '2026-11-07T12:01:00.000Z' };
    await s.putNumbers(n);
    expect(await s.numbers('con_pgtest0001')).toEqual(n);
    await s.putNumbers({ ...n, connection_id: 'con_missing001' });
    expect(await s.numbers('con_missing001')).toBeNull();
    expect((await s.byAccount('acc_test0001')).map((r) => r.conn.connection_id)).toEqual(['con_pgtest0001']);
    await s.remove('con_pgtest0001');
    expect(await s.get('con_pgtest0001')).toBeNull();
    expect(await s.numbers('con_pgtest0001')).toBeNull();
    await s.end();
  });
});
