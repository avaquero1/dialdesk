/**
 * The Postgres usage store, against a real database. Runs only when MODELS_TEST_DATABASE_URL is set (a throwaway
 * database: it creates schema "models_test" and drops it after).
 */
import postgres from 'postgres';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { createLogger, migrate } from '@app/service-kit';
import { DEFAULT_CAPS, Meter, PgUsageStore } from '../src/meter.ts';

const url = process.env.MODELS_TEST_DATABASE_URL;
const SCHEMA = 'models_test';

describe.skipIf(!url)('models: the Postgres usage store', () => {
  const admin = url ? postgres(url, { max: 1, onnotice: () => {} }) : null;
  afterAll(async () => {
    await admin?.unsafe(`drop schema if exists ${SCHEMA} cascade`);
    await admin?.end();
  });

  it('migrates, adds up rows per day/account/role/model, and a new meter reloads today from it', async () => {
    await admin!.unsafe(`drop schema if exists ${SCHEMA} cascade; create schema ${SCHEMA}`);
    const applied = await migrate({ databaseUrl: url!, schema: SCHEMA, dir: fileURLToPath(new URL('../migrations', import.meta.url)), log: createLogger('models', 'silent') });
    expect(applied).toEqual(['0001_init.sql', '0002_usage.sql']);
    const store = new PgUsageStore(url!, SCHEMA);
    const row = { day: '2026-11-08', account: 'acc_test0001', role: 'reader' as const, model: 'qwen3.8-flash-next', calls: 1, input_tokens: 100, output_tokens: 20, cost_usd: 0.000014 };
    await store.add(row);
    await store.add({ ...row, input_tokens: 50 });
    await store.add({ ...row, account: 'system', role: 'guard', model: 'nemotron-3.5-content-safety', cost_usd: 0.00001 });
    const rows = await store.load('2026-11-08');
    expect(rows.find((r) => r.account === 'acc_test0001')).toMatchObject({ calls: 2, input_tokens: 150, output_tokens: 40, cost_usd: 0.000028 });
    expect(await store.load('2026-11-09')).toEqual([]);
    const m = new Meter(DEFAULT_CAPS, store, () => new Date('2026-11-08T12:00:00Z'));
    await m.open();
    const s = await m.spend();
    expect(s.total_usd).toBeCloseTo(0.000038, 10);
    expect(s.by_role.guard).toBeCloseTo(0.00001, 10);
    expect((await m.spend('acc_test0001')).total_usd).toBeCloseTo(0.000028, 10);
    await store.end();
  });
});
