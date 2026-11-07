/**
 * The contract gate: every service's fake, driven through its cases, must accept and answer exactly what
 * packages/contracts says. It also checks that every endpoint has a case, that the app serves no route outside
 * its contract, and that the token check refuses callers an endpoint doesn't list.
 */
import { describe, expect, it } from 'vitest';
import { APIS, type Endpoint } from '@app/contracts';
import { outsider, runCase, TEST_TOKENS, type Case, type Ctx } from '@app/testkit';
import type { Hono } from 'hono';
import * as accounts from '../services/accounts/test/cases.ts';
import * as agent from '../services/agent/test/cases.ts';
import * as audit from '../services/audit/test/cases.ts';
import * as board from '../services/board/test/cases.ts';
import * as connections from '../services/connections/test/cases.ts';
import * as edge from '../services/edge/test/cases.ts';
import * as markets from '../services/markets/test/cases.ts';
import * as models from '../services/models/test/cases.ts';
import * as runner from '../services/runner/test/cases.ts';

type Suite = { api: Record<string, Endpoint>; makeApp: () => Hono; cases: Case[] };
const SUITES: Record<keyof typeof APIS, Suite> = { edge, accounts, board, agent, runner, markets, connections, models, audit };

for (const [service, suite] of Object.entries(SUITES)) {
  describe(`contract: ${service}`, () => {
    const app = suite.makeApp();
    const ctx: Ctx = {};

    it('uses the table in packages/contracts', () => {
      expect(suite.api).toBe(APIS[service as keyof typeof APIS]);
    });

    it('has a success case for every endpoint', () => {
      const covered = new Set(suite.cases.filter((c) => c.expect === undefined || c.expect === suite.api[c.endpoint]?.status).map((c) => c.endpoint));
      expect(Object.keys(suite.api).filter((n) => !covered.has(n))).toEqual([]);
    });

    it('serves no route outside its contract', () => {
      const declared = new Set(Object.values(suite.api).map((e) => `${e.method} ${e.path}`));
      const served = app.routes.map((r) => `${r.method} ${r.path}`).filter((r) => r !== 'GET /health' && !r.startsWith('ALL '));
      expect(served.filter((r) => !declared.has(r))).toEqual([]);
    });

    it('answers /health', async () => {
      const res = await app.request('/health');
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, service, mode: 'fake' });
    });

    for (const [i, c] of suite.cases.entries()) {
      it(`${i + 1}. ${c.endpoint}${c.label ? ` (${c.label})` : ''} as ${c.caller}`, async () => {
        const out = await runCase(app, suite.api, c, ctx);
        expect(out.problems).toEqual([]);
      });
    }

    it('refuses a caller the endpoint does not list (403) and a missing token (401)', async () => {
      for (const e of Object.values(suite.api)) {
        if (e.callers.includes('public') || e.callers.includes('browser')) continue;
        const who = outsider(e);
        const path = e.path.replace(/:([a-z_]+)/g, 'x');
        const r1 = await app.request(path, { method: e.method, headers: { authorization: `Bearer ${TEST_TOKENS[who!]}` } });
        expect(r1.status, `${e.name} as ${who}`).toBe(403);
        const r2 = await app.request(path, { method: e.method });
        expect(r2.status, `${e.name} without a token`).toBe(401);
      }
    });
  });
}
