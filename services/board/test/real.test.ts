/**
 * The real board against Postgres: the contract cases and the behaviors, on a fresh account each run.
 * Needs the dev Postgres (`make infra-up`, or your own Compose project). The URL comes from BOARD_TEST_DATABASE_URL,
 * else BOARD_DATABASE_URL, else the repo's .env. Without a reachable database the suite is skipped and says so.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BOARD, newId, type WidgetRunJob } from '@app/contracts';
import { MemoryBus, buildApp, createLogger, migrate } from '@app/service-kit';
import { runCase, testCallers, TEST_TOKENS, type Ctx } from '@app/testkit';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
import { connect, createReal, pgAccountData } from '../src/real.ts';
import { MemoryObjectStore } from '../src/storage.ts';
import { boardBehaviors } from './behaviors.ts';
import { connectionsForBoard, makeCases, marketsForBoard } from './cases.ts';

function databaseUrl(): string | undefined {
  const env = process.env.BOARD_TEST_DATABASE_URL ?? process.env.BOARD_DATABASE_URL;
  if (env) return env;
  try {
    const line = readFileSync(join(import.meta.dirname, '../../../.env'), 'utf8').split('\n').find((l) => l.startsWith('BOARD_DATABASE_URL='));
    return line?.slice('BOARD_DATABASE_URL='.length);
  } catch {
    return undefined;
  }
}

async function reachable(url: string | undefined): Promise<boolean> {
  if (!url) return false;
  const probe = postgres(url, { max: 1, connect_timeout: 2, onnotice: () => {} });
  try {
    await probe`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await probe.end({ timeout: 1 });
  }
}

const url = databaseUrl();
const up = await reachable(url);
if (!up) console.warn(`board real-mode tests SKIPPED: no Postgres at BOARD_DATABASE_URL (${url ? 'unreachable' : 'unset'})`);

const pools: postgres.Sql[] = [];
afterAll(async () => {
  await Promise.all(pools.map((p) => p.end({ timeout: 2 })));
});

async function realApp(markets: ReturnType<typeof marketsForBoard> = marketsForBoard()) {
  const log = createLogger('board', 'silent');
  await migrate({ databaseUrl: url!, schema: 'board', dir: join(import.meta.dirname, '../migrations'), log });
  const sql = connect(url!);
  pools.push(sql);
  const bus = new MemoryBus();
  const jobs: WidgetRunJob[] = [];
  const handlers = createReal({ sql, bus, enqueue: async (_q, j) => void jobs.push(j), markets, connections: connectionsForBoard(), objects: new MemoryObjectStore() });
  const app = buildApp({ service: 'board', mode: 'real', api: BOARD, handlers, callers: testCallers(), log });
  return { app, bus, jobs };
}

describe.skipIf(!up)('contract: board (real, Postgres)', async () => {
  const { app } = up ? await realApp() : ({} as never);
  const ctx: Ctx = {};
  for (const [i, c] of makeCases(newId('acc')).entries()) {
    it(`${i + 1}. ${c.endpoint}${c.label ? ` (${c.label})` : ''} as ${c.caller}`, async () => {
      const out = await runCase(app, BOARD, c, ctx);
      expect(out.problems).toEqual([]);
    });
  }
});

if (up) boardBehaviors('real (Postgres)', realApp);

describe.skipIf(!up)('board (real, Postgres): no list at sign-up (A1.4.10)', () => {
  it('a new board says its games are samples', async () => {
    await Promise.all(pools.splice(0).map((p) => p.end({ timeout: 2 })));
    const down = (async () => {
      throw new Error('503');
    }) as never;
    const { app } = await realApp(down);
    const out = await runCase(app, BOARD, { endpoint: 'createDefaults', caller: 'edge', input: () => ({ params: { account_id: newId('acc') }, body: { category: 'sports' } }) }, {});
    expect(out.problems).toEqual([]);
    const text = JSON.stringify(out.body);
    expect(text).toContain('Sample games');
    expect(text).toContain('Sample: Chiefs beat the Bills');
  });
});

describe.skipIf(!up)('board (real, Postgres): a deleted account takes its board with it', () => {
  it('forget deletes the board, its folders, tiles, layout, proposals and run requests, and leaves other boards', async () => {
    // svc_board may hold 5 connections: the earlier suites are done, so their pools go first.
    await Promise.all(pools.splice(0).map((p) => p.end({ timeout: 2 })));
    const { app } = await realApp();
    const sql = pools.at(-1)!;
    const data = pgAccountData(sql);
    const [gone, kept] = [newId('acc'), newId('acc')];
    for (const a of [gone, kept]) {
      const res = await app.request(`/boards/${a}`, { method: 'POST', headers: { authorization: `Bearer ${TEST_TOKENS.edge}`, 'content-type': 'application/json' }, body: JSON.stringify({ category: 'sports' }) });
      expect(res.status).toBe(201);
    }
    const count = async (table: string, a: string) => (await sql<{ n: number }[]>`select count(*)::int as n from ${sql(table)} where account_id = ${a}`)[0]!.n;
    expect(await count('widgets', gone)).toBeGreaterThan(0);
    expect(await data.accountIds()).toEqual(expect.arrayContaining([gone, kept]));
    expect(await data.forget(gone)).toBe(1);
    for (const table of ['boards', 'widgets', 'layout', 'proposals', 'run_requests', 'results', 'screenshots']) expect(await count(table, gone), table).toBe(0);
    expect(await count('widgets', kept)).toBeGreaterThan(0);
    expect(await data.forget(gone)).toBe(0);
  }, 30_000);
});
