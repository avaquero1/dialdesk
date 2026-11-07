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

export const ROLES: Record<ModelRole, RoleSpec> = {
  // Tool calling and good conversation.
  chat: { models: ['glm-5.3', 'mimo-v2.6-pro'], tools: true, max_tokens: 1024, temperature: 0.4, reasoning_effort: 'low' },
  // Tool calling, cheap.
  planner: { models: ['qwen3.8-27b', 'deepseek-v4.1-flash-1017'], tools: true, max_tokens: 1024, temperature: 0, reasoning_effort: 'minimal' },
  // Text in, facts out. No tools, ever.
  reader: { models: ['qwen3.8-flash-next', 'mimo-v2.6-flash'], tools: false, max_tokens: 1024, temperature: 0, reasoning_effort: 'minimal' },
  // Cheap, strict style: slot templates, never digits.
  summarizer: { models: ['qwen3.8-flash-next'], tools: false, max_tokens: 256, temperature: 0.2, reasoning_effort: 'minimal' },
  // The guard's second layer (packages/guard decides how to ask).
  guard: { models: ['nemotron-3.5-content-safety', 'qwen3.8-flash-next'], tools: false, max_tokens: 128, temperature: 0, reasoning_effort: 'minimal' },
};

export function rolesFromEnv(env: Record<string, string | undefined>): Record<ModelRole, RoleSpec> {
  const out = structuredClone(ROLES);
  for (const role of Object.keys(out) as ModelRole[]) {
    const list = env[`ROLE_${role.toUpperCase()}`];
    if (list) out[role].models = list.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return out;
}
