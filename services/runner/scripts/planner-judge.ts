/**
 * One planner answer, judged as runner judges it (A1.3.5): does its plan pass planProblem, and does the engine
 * (target/debug/engine) compute its numbers on this weekend's recorded markets? Shared by scripts/planner-proof.ts and
 * its replay test, so both judge the same way.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { EngineResult, MARKETS, type DisplayType, type Market, type WidgetSpec } from '@app/contracts';
import { createClient, createLogger } from '@app/service-kit';
import { TEST_TOKENS } from '@app/testkit';
import { WEEKEND_RESOLVED, realApp, weekendFetch } from '../../markets/test/recorded.ts';
import { marketNumbers, planProblem, runnablePlan } from '../src/plans.ts';
import { jsonOf } from '../src/run.ts';

export type DisplaySpec = Extract<WidgetSpec, { kind: 'display' }>;
export const ENGINE = join(import.meta.dirname, '../../../target/debug/engine');
const AT = Date.parse(WEEKEND_RESOLVED.recorded_at);
const app = realApp({ BRAVE_KEY_FILE: '/nonexistent/brave-search', HISTORY_PER_MIN: 6000, RESOLVED_PER_MIN: 6000, RESOLVED_WAIT_S: 30 }, { fetch: weekendFetch().fetch, now: () => AT, log: createLogger('markets', 'silent') });
export const markets = createClient({ baseUrl: 'http://svc.internal', token: TEST_TOKENS.runner, fetch: (r) => app.fetch(r) });

/** The types whose plans go through planProblem (gap, Biggest move and positions build their own). */
export const PLANNED_TYPES = ['news', 'events', 'probability', 'movement'] as const satisfies readonly DisplayType[];

/** This weekend's first NFL games on Kalshi priced 25..75¢ (the away team's market, as boards pick it). */
export async function weekendGames(n: number): Promise<Market[]> {
  const list = await markets(MARKETS.list, { query: { league: 'nfl' } });
  return list.markets
    .filter((m) => m.exchange === 'kalshi' && m.event_key && m.market_id.endsWith(`-${m.event_key.split('-')[4]!.toUpperCase()}`) && m.yes_price_cents >= 25 && m.yes_price_cents <= 75)
    .slice(0, n);
}

export async function specFor(type: (typeof PLANNED_TYPES)[number]): Promise<DisplaySpec> {
  const games = await weekendGames(type === 'events' ? 3 : 1);
  const params = type === 'probability' ? { user_probability: 0.6 } : type === 'movement' ? { window_s: 86400 } : {};
  return { kind: 'display', widget_id: `wdg_planproof${type}`, account_id: 'acc_planproof0001', type, title: type, size: 'M', market_ids: games.map((g) => g.market_id), params, sources: [] } as unknown as DisplaySpec;
}

export interface Verdict {
  /** planProblem's reason, or null when the plan passes. */
  problem: string | null;
  ops: number;
  /** Numbers the engine computed from the plan (0 when refused). */
  computed: number;
  engine_errors: number;
}

export async function judge(spec: DisplaySpec, content: string): Promise<Verdict> {
  const plan = (jsonOf(content) as { plan?: unknown } | null)?.plan;
  const problem = plan === undefined ? 'no plan' : planProblem(spec, plan);
  const ops = Array.isArray((plan as { ops?: unknown[] } | undefined)?.ops) ? (plan as { ops: unknown[] }).ops.length : 0;
  if (problem) return { problem, ops, computed: 0, engine_errors: 0 };
  const p = plan as Parameters<typeof runnablePlan>[0];
  const mn = await marketNumbers(markets, spec, p);
  const r = spawnSync(ENGINE, [], { input: JSON.stringify({ plan: runnablePlan(p, mn.numbers), numbers: mn.numbers, origins: mn.origins, provenance: mn.provenance }), encoding: 'utf8' });
  if (r.status !== 0) return { problem, ops, computed: 0, engine_errors: 1 };
  const er = EngineResult.parse(JSON.parse(r.stdout));
  return { problem, ops, computed: er.numbers.length, engine_errors: er.errors.length };
}
