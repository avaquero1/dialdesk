/**
 * The planner knows the args (A1.3.5, recorded with scripts/planner-proof.ts; no key in the file): the real planner's
 * answers, asked with the prompt that lists every op's args from the engine's schema, judged again by today's code
 * (planProblem, then the engine on this weekend's recorded markets).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ENGINE, judge, type DisplaySpec, type Verdict } from '../scripts/planner-judge.ts';

type Case = { type: string; rep: number; spec: DisplaySpec; model: string; content: string; verdict: Verdict };
const rec = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/planner-proof-a1-3-5.json'), 'utf8')) as {
  spend: { cap_usd: number; spent_usd: number; stopped: string | null };
  cases: (Case | { type: string; rep: number; error: string })[];
};
const answered = rec.cases.filter((c): c is Case => 'content' in c);

describe("the real planner's plans (recorded)", () => {
  it('ran under the cap, never stopped, every call answered', () => {
    expect(rec.spend.cap_usd).toBeLessThanOrEqual(0.25);
    expect(rec.spend.spent_usd).toBeLessThan(rec.spend.cap_usd);
    expect(rec.spend.stopped).toBeNull();
    expect(answered).toHaveLength(rec.cases.length);
  });

  it.skipIf(!existsSync(ENGINE))('today\'s code judges every recorded answer as it was judged then', async () => {
    for (const c of answered) expect(await judge(c.spec, c.content), `${c.type}/${c.rep}`).toEqual(c.verdict);
  });

  it('most plans pass the check, and the engine computes every op of each plan that passes', () => {
    const passed = answered.filter((c) => c.verdict.problem === null);
    process.stdout.write(`[planner proof] ${passed.length} of ${answered.length} plans pass; ${passed.filter((c) => c.verdict.computed === c.verdict.ops).length} fully computed\n`);
    expect(passed.length).toBeGreaterThan(answered.length / 2);
    for (const c of passed) {
      expect(c.verdict.engine_errors, `${c.type}/${c.rep}`).toBe(0);
      expect(c.verdict.computed, `${c.type}/${c.rep}`).toBe(c.verdict.ops);
    }
  });
});
