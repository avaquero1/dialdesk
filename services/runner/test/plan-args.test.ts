/**
 * planProblem checks each op's arg names against the engine's own op schema (`engine --schema`, "ops"). The real
 * planners wrote `{"price": …}` for `{"price_cents": …}` (A1.3.3's first trial, and every planner answer of the model
 * bake-off): such a plan is refused up front, with a reason, and the default plan runs instead.
 */
import { ENGINE_OP_ARGS, type DisplayType, type EnginePlan, type WidgetSpec } from '@app/contracts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { argProblem, defaultPlan, keyKind, numberKeys, planProblem } from '../src/plans.ts';
import { PLANNER_PROMPT } from '../src/run.ts';

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

  it("a key of the wrong kind is refused with a plain reason (a price where a series goes, a series where a number goes)", () => {
    expect(argProblem({ id: 'n3', op: 'movement', args: { series: 'price_1', window_s: 'window_s' } })).toBe('op n3 (movement) arg series takes a series, not a price');
    expect(argProblem({ id: 'n1', op: 'implied_probability', args: { price_cents: 'series_1' } })).toBe('op n1 (implied_probability) arg price_cents takes a number, not a series');
    expect(argProblem({ id: 'n2', op: 'base_rate_history', args: { history: 'kalshi_series' } })).toBe('op n2 (base_rate_history) arg history takes a history, not a series');
    expect(argProblem({ id: 'n4', op: 'price_at', args: { series: 'n1', ago_s: 'ago_1' } })).toBe('op n4 (price_at) arg series takes a series, not a number (op n1)');
    expect(planProblem(spec('news'), { plan_version: 1, ops: [{ id: 'n1', op: 'movement', args: { series: 'kalshi_price', window_s: 'window_s' } }] })).toBe(
      'op n1 (movement) arg series takes a series, not a price',
    );
    // An op's output is a number: it may feed a number arg.
    expect(argProblem({ id: 'n2', op: 'price_to_odds', args: { probability: 'n1' } })).toBeNull();
  });

  it('every key a plan may read has a kind', () => {
    for (const type of ['events', 'probability', 'gap', 'news', 'movement'] as const) for (const k of numberKeys(spec(type))) expect(keyKind(k), `${type} ${k}`).not.toBeNull();
  });
});

describe("the planner's prompt, from the engine's op schema", () => {
  it('names every engine op, one line each, with every arg name and its kind', () => {
    const ops = Object.entries(ENGINE_OP_ARGS);
    expect(ops.length).toBeGreaterThanOrEqual(12);
    for (const [op, args] of ops) {
      const lines = PLANNER_PROMPT.split('\n').filter((l) => l.startsWith(`- ${op}: `));
      expect(lines, op).toHaveLength(1);
      for (const a of args!) expect(lines[0], `${op} ${a.name}`).toContain(`"${a.name}": ${a.kind === 'num' ? 'number' : a.kind}${a.required ? '' : ' (optional)'}`);
    }
    expect(PLANNER_PROMPT.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(ops.length);
  });
});

