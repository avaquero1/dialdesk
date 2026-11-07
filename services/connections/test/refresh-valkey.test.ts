/**
 * account-refresh on a real Valkey, as the svc-connections ACL user: consent enqueues a BullMQ job, the worker reads
 * the (mock) exchange through GET only, and the numbers land in the store. Runs only when CONNECTIONS_TEST_VALKEY_URL
 * is set (a throwaway Valkey loaded with deploy/.dev/valkey-users.acl, e.g. the connections user's URL from .env
 * with the port changed).
 */
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { MemoryBus } from '@app/service-kit';
import { createConnections } from '../src/real.ts';
import { seal, sealAad } from '../src/seal.ts';
import { MemoryStore } from '../src/store.ts';
import { mockExchange } from './mock-exchange.ts';

const url = process.env.CONNECTIONS_TEST_VALKEY_URL;
const ACC = 'acc_test0001';
const KID = 'a1b2c3d4-0000-4000-8000-00000000read';

describe.skipIf(!url)('connections: account-refresh on Valkey', () => {
  let conns: Awaited<ReturnType<typeof createConnections>> | undefined;
  afterAll(async () => conns?.close());

  it('consent → job → GET-only reads → numbers in the store', async () => {
    const ex = mockExchange();
    const key = generateKeyPairSync('ed25519').privateKey;
    ex.addKey(KID, key);
    const store = new MemoryStore();
    conns = await createConnections({ VALKEY_URL: url, REFRESH_EVERY_S: '30' }, { master: randomBytes(32), fetch: ex.fetch, bus: new MemoryBus(), store });
    const h = conns.handlers as any;
    const { public_key } = await h.publicKey({}, {});
    const pem = key.export({ type: 'pkcs8', format: 'pem' }) as string;
    const body = { account_id: ACC, exchange: 'kalshi', key_id: KID, key_type: 'ed25519', env: 'demo', sealed_key: await seal(public_key, pem, sealAad(ACC, KID)) };
    const c = await h.connect({ body }, {});
    await h.setConsent({ params: { connection_id: c.connection_id }, body: { account_id: ACC, share_numbers: true } }, {});
    let n = null;
    for (let i = 0; i < 100 && !n; i++) {
      await new Promise((r) => setTimeout(r, 100));
      n = await store.numbers(c.connection_id);
    }
    expect(n).toMatchObject({ connection_id: c.connection_id, balance_cents: 124018 });
    expect(n!.positions).toHaveLength(3);
    expect(ex.calls.every((x) => x.method === 'GET')).toBe(true);
    expect(ex.calls.map((x) => new URL(x.url).pathname).sort()).toEqual([
      '/trade-api/v2/api_keys',
      '/trade-api/v2/portfolio/balance',
      '/trade-api/v2/portfolio/positions',
    ]);
  }, 30_000);
});
