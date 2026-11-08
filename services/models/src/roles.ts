import type { ModelRole } from '@app/contracts';

/**
 * The role -> model map (architecture, "Models"). The first model answers; the next ones are tried in order when it is
 * down (5xx, timeout, 404, 503). `MODELS_ROLE_<ROLE>=id,id` overrides a list without a code change (the bake-off).
 */
export interface RoleSpec {
  models: string[];
  /** Function tools allowed. The reader never gets tools. */
  tools: boolean;
  /** Default and hard upper bound for max_tokens (the caller may ask for less). */
  max_tokens: number;
  temperature: number;
  /** Sent as `reasoning_effort` when set. Reasoning tokens are billed as output tokens. */
  reasoning_effort?: 'minimal' | 'low' | 'medium';
}

// Picked by the bake-off on real Vultr runs (A1.2.1, 2026-11-08 UTC; scripts/bakeoff.ts, recorded in test/fixtures/bakeoff-answers.json
// and packages/guard/test/fixtures/bakeoff-answers.json). The first model is the pick, the second the best runner-up as fallback.
export const ROLES: Record<ModelRole, RoleSpec> = {
  // glm-5.3-flash: 15/15 turns (asks for teams, one chip per proposal, "I do math, not calls." on bait, set_look), about 0.04 cents a
  // call and 0.5 s. mimo-v2.6-pro: 15/15, four times the cost. glm-5.3 (the first pick) is out: 13/15 (twice no question about
  // teams) at seven times the cost.
  chat: { models: ['glm-5.3-flash', 'mimo-v2.6-pro'], tools: true, max_tokens: 1024, temperature: 0.4, reasoning_effort: 'low' },
  // All three passed 16/16 once max_tokens went from 1024 to 2048 (at 1024 qwen and deepseek cut the plan off half the time).
  // mimo-v2.6-flash is the cheapest by five times and faster than deepseek.
  planner: { models: ['mimo-v2.6-flash', 'qwen3.8-27b'], tools: true, max_tokens: 2048, temperature: 0, reasoning_effort: 'minimal' },
  // Text in, facts out. No tools, ever. mimo-v2.6-flash and qwen3.8-flash-next: 12/12 each at the same cost. mimo is first because on
  // the poisoned page it sometimes reports that the page holds orders aimed at AI agents, so the guard kills the box; the others leave
  // the orders out. deepseek: 10/12 (no facts twice).
  reader: { models: ['mimo-v2.6-flash', 'qwen3.8-flash-next'], tools: false, max_tokens: 1024, temperature: 0, reasoning_effort: 'minimal' },
  // Cheap, strict style: slot templates, never digits. glm-5.3-flash and mimo-v2.6-flash: 8/8. qwen3.8-flash-next is out: 2/8,
  // its reasoning used up max_tokens 256 (an empty or cut-off answer).
  summarizer: { models: ['glm-5.3-flash', 'mimo-v2.6-flash'], tools: false, max_tokens: 256, temperature: 0.2, reasoning_effort: 'minimal' },
  // The guard's second layer (packages/guard decides how to ask). mimo-v2.6-flash and deepseek-v4.1-flash-1017: 45/45, both flag
  // exactly the poisoned scenario's planted orders on every run. qwen3.8-flash-next is out: on the poisoned facts it returned
  // nothing all five times (reasoning used up the 256 tokens), which is "unchecked": a block, not a kill. nemotron-3.5-content-safety
  // was dropped after the first real calls (A1.1.1): it echoes the reply back and judges harm, not advice or orders.
  guard: { models: ['mimo-v2.6-flash', 'deepseek-v4.1-flash-1017'], tools: false, max_tokens: 256, temperature: 0, reasoning_effort: 'minimal' },
};

export function rolesFromEnv(env: Record<string, string | undefined>): Record<ModelRole, RoleSpec> {
  const out = structuredClone(ROLES);
  for (const role of Object.keys(out) as ModelRole[]) {
    const list = env[`ROLE_${role.toUpperCase()}`];
    if (list) out[role].models = list.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return out;
}
