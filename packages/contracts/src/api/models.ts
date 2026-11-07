import { z } from 'zod';
import { AccountId, Timestamp } from '../common.ts';
import { api } from '../endpoint.ts';

export const ModelRole = z.enum(['chat', 'planner', 'reader', 'summarizer', 'guard']);
export type ModelRole = z.infer<typeof ModelRole>;

/**
 * Fake mode only (MODELS_FAKE=1): the canned answer to give. The real mode ignores it.
 * `poisoned` = the reader returns facts that carry orders aimed at the agent; `advice` = the chat or summarizer
 * answers with advice wording (the guard must block it).
 */
export const FakeScenario = z.enum(['clean', 'poisoned', 'advice', 'error']);
export type FakeScenario = z.infer<typeof FakeScenario>;

export const ChatMessage = z
  .object({
    role: z.enum(['system', 'user', 'assistant', 'tool']),
    content: z.string().max(100_000),
    tool_name: z.string().optional(),
  })
  .strict();

export const ToolDef = z.object({ name: z.string(), parameters: z.record(z.string(), z.unknown()) }).strict();
export const ToolCall = z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()) }).strict();

export const Usage = z
  .object({ input_tokens: z.number().int().min(0), output_tokens: z.number().int().min(0), cost_usd: z.number().min(0) })
  .strict();

export const CompleteBody = z
  .object({
    role: ModelRole,
    account_id: AccountId.nullable(),
    messages: z.array(ChatMessage).min(1).max(100),
    tools: z.array(ToolDef).max(20).optional(),
    json: z.boolean().optional().describe('ask for a JSON object answer'),
    max_tokens: z.number().int().min(1).max(8192).optional(),
    scenario: FakeScenario.optional(),
  })
  .strict();
export type CompleteBody = z.infer<typeof CompleteBody>;

export const Completion = z
  .object({
    model: z.string().describe('the model that answered, e.g. "fake/reader/poisoned" in fake mode'),
    content: z.string(),
    tool_calls: z.array(ToolCall),
    usage: Usage,
  })
  .strict();
export type Completion = z.infer<typeof Completion>;

export const Spend = z
  .object({
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    total_usd: z.number().min(0),
    by_role: z.record(ModelRole, z.number().min(0)),
    daily_cap_usd: z.number().min(0),
    remaining_usd: z.number(),
    kill_switch: z.boolean().describe('true = global spend cap reached; every call is refused'),
    as_of: Timestamp,
  })
  .strict();

export const MODELS = api('models', {
  complete: {
    method: 'POST',
    path: '/complete',
    callers: ['agent', 'runner'],
    body: CompleteBody,
    response: Completion,
    errors: [400, 402, 429, 502],
    summary: 'One model call for a role. Refused if the prompt holds a key (400) or a cap is reached (402).',
  },
  spend: {
    method: 'GET',
    path: '/spend',
    callers: ['edge'],
    query: z.object({ account_id: AccountId.optional() }),
    response: Spend,
    summary: "Today's Vultr Inference spend per role (the trust page).",
  },
});
