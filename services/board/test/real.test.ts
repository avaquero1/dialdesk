/**
 * The real board against Postgres: the contract cases and the behaviors, on a fresh account each run.
 * Needs the dev Postgres (`make infra-up`, or your own Compose project). The URL comes from BOARD_TEST_DATABASE_URL,
 * else BOARD_DATABASE_URL, else the repo's .env. Without a reachable database the suite is skipped and says so.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BOARD, newId, type WidgetRunJob } from '@app/contracts';
import { MemoryBus, buildApp, createLogger, migrate } from '@app/service-kit';
import { runCase, testCallers, type Ctx } from '@app/testkit';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
import { connect, createReal } from '../src/real.ts';
import { MemoryObjectStore } from '../src/storage.ts';
import { boardBehaviors } from './behaviors.ts';
import { makeCases, marketsForBoard } from './cases.ts';

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

async function realApp() {
  const log = createLogger('board', 'silent');
  await migrate({ databaseUrl: url!, schema: 'board', dir: join(import.meta.dirname, '../migrations'), log });
  const sql = connect(url!);
  pools.push(sql);
  const bus = new MemoryBus();
  const jobs: WidgetRunJob[] = [];
  const handlers = createReal({ sql, bus, enqueue: async (_q, j) => void jobs.push(j), markets: marketsForBoard(), objects: new MemoryObjectStore() });
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
