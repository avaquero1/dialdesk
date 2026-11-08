/**
 * planProblem checks each op's arg names against the engine's own op schema (`engine --schema`, "ops"). The real
 * planners wrote `{"price": …}` for `{"price_cents": …}` (A1.3.3's first trial, and every planner answer of the model
 * bake-off): such a plan is refused up front, with a reason, and the default plan runs instead.
 */
import { ENGINE_OP_ARGS, type DisplayType, type EnginePlan, type WidgetSpec } from '@app/contracts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { argProblem, defaultPlan, planProblem } from '../src/plans.ts';

type DisplaySpec = Extract<WidgetSpec, { kind: 'display' }>;
const spec = (type: DisplayType, market_ids = ['kalshi:KXNFLGAME-26NOV08KCBUF-KC', 'polymarket:nfl-kc-buf-2026-11-08']) =>
  ({ kind: 'display', widget_id: 'wdg_planargs', account_id: 'acc_planargs', type, title: 'Market', size: 'M', market_ids, params: { user_probability: 0.6 }, sources: [] }) as unknown as DisplaySpec;

type Case = { role: string; model: string; scenario: string; rep: number; answers: { content: string }[] };
const bakeoff = JSON.parse(readFileSync(join(import.meta.dirname, '../../models/test/fixtures/bakeoff-answers.json'), 'utf8')) as { cases: Case[] };
const recorded = bakeoff.cases
  .filter((c) => c.role === 'planner')
  .flatMap((c) => c.answers.map((a) => ({ label: `${c.model} ${c.scenario} rep ${c.rep}`, plan: (JSON.parse(a.content) as { plan: EnginePlan }).plan })));

describe("a plan's arg names, against the engine's op schema", () => {
  it('the engine schema names every op and its args', () => {
    expect(ENGINE_OP_ARGS.implied_probability).toEqual([{ name: 'price_cents', kind: 'num', required: true }]);
    expect(ENGINE_OP_ARGS.movement!.map((a) => a.name)).toEqual(['series', 'window_s']);
    expect(ENGINE_OP_ARGS.base_rate_history!.filter((a) => !a.required).map((a) => a.name)).toEqual(['lo_cents', 'hi_cents']);
  });

  it("A1.3.3's real plan ({\"price\": …} for {\"price_cents\": …}) is refused with the reason", () => {
    const plan = { plan_version: 1, ops: [{ id: 'n1', op: 'implied_probability', args: { price: 'kalshi_price' } }] };
    expect(planProblem(spec('news'), plan)).toBe('op n1 (implied_probability) has no arg price; it takes price_cents');
  });

  it('a required arg left out is refused', () => {
    expect(argProblem({ id: 'n2', op: 'movement', args: { series: 'series_1' } })).toBe('op n2 (movement) needs arg window_s');
    expect(argProblem({ id: 'n3', op: 'base_rate_history', args: { history: 'home_history' } })).toBeNull();
  });

  it(`every recorded real planner plan (${recorded.length}, the model bake-off) is refused for its arg names`, () => {
    expect(recorded.length).toBe(48);
    for (const { label, plan } of recorded) {
      const why = plan.ops.map(argProblem).find((p) => p !== null);
      expect(why, label).toMatch(/^op n\d+ \((implied_probability|movement)\) (has no arg \w+; it takes|needs arg)/);
      for (const type of ['events', 'probability', 'news'] as const) expect(planProblem(spec(type), plan), `${label} ${type}`).not.toBeNull();
    }
  });

  it("no type's default plan is refused (the check never stops the plan that runs instead; positions has none)", () => {
    for (const type of ['events', 'probability', 'gap', 'news', 'movement'] as const) {
      const s = spec(type);
      const plan = defaultPlan(s);
      expect(plan.ops.length, type).toBeGreaterThan(0);
      for (const op of plan.ops) expect(argProblem(op), `${type} ${op.id}`).toBeNull();
      expect(planProblem(s, plan), type).toBeNull();
    }
  });
});
