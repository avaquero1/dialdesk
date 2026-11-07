import type { z } from 'zod';
import type { ChatMessage, ToolCall, ToolDef } from '@app/contracts';

/**
 * The Vultr Serverless Inference client: POST {base}/chat/completions, OpenAI-shaped
 * (https://api.vultrinference.com/docs). The only code in the app that talks to Vultr Inference.
 * The key goes in the Authorization header and nowhere else: not in an error, not in a log.
 */
export interface ChatRequest {
  model: string;
  messages: z.infer<typeof ChatMessage>[];
  tools?: z.infer<typeof ToolDef>[];
  json?: boolean;
  max_tokens: number;
  temperature: number;
  reasoning_effort?: string;
}

export interface ChatAnswer {
  model: string;
  content: string;
  tool_calls: z.infer<typeof ToolCall>[];
  finish_reason: string | null;
  usage: { input_tokens: number; output_tokens: number } | null;
}

/** An upstream failure. `retry` = another model may answer (down, overloaded, unknown model). */
export class UpstreamError extends Error {
  constructor(
    readonly status: number,
    readonly kind: string,
    readonly retry: boolean,
  ) {
    super(`vultr inference: ${status} ${kind}`);
  }
}

export interface VultrClientOptions {
  baseUrl: string;
  /** Called for each request, so a key file that appears later is picked up. Returns null when there is no key. */
  key: () => string | null;
  timeoutMs: number;
  fetch?: typeof fetch;
}

type Wire = {
  model?: string;
  choices?: { message?: { content?: string | null; tool_calls?: { function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { type?: string; metadata?: { error_type?: string } };
};

/** Our messages to the wire. A `tool` message becomes a user message naming the tool: the contract carries no tool_call_id. */
function wireMessages(messages: ChatRequest['messages']) {
  return messages.map((m) =>
    m.role === 'tool' ? { role: 'user', content: `[tool result${m.tool_name ? `: ${m.tool_name}` : ''}]\n${m.content}` } : { role: m.role, content: m.content },
  );
}

function parseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : { _unparsed: raw };
  } catch {
    return { _unparsed: raw };
  }
}

/** Some models wrap a JSON answer in a ``` fence even when asked for json_object. */
function unfence(s: string): string {
  const m = /^\s*```(?:json)?\s*\n([\s\S]*?)\n?```\s*$/.exec(s);
  return m ? m[1]! : s;
}

export function createVultrClient(opts: VultrClientOptions) {
  const doFetch = opts.fetch ?? fetch;
  return async function chat(req: ChatRequest): Promise<ChatAnswer> {
    const key = opts.key();
    if (!key) throw new UpstreamError(0, 'no_key', false);
    const body: Record<string, unknown> = {
      model: req.model,
      messages: wireMessages(req.messages),
      max_tokens: req.max_tokens,
      temperature: req.temperature,
      stream: false,
    };
    if (req.reasoning_effort) body.reasoning_effort = req.reasoning_effort;
    if (req.json) body.response_format = { type: 'json_object' };
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, parameters: t.parameters } }));
      body.tool_choice = 'auto';
    }
    let res: Response;
    try {
      res = await doFetch(`${opts.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
    } catch (e) {
      const timeout = (e as Error).name === 'TimeoutError';
      throw new UpstreamError(0, timeout ? 'timeout' : 'network', true);
    }
    const data = (await res.json().catch(() => ({}))) as Wire;
    if (!res.ok) {
      const kind = data.error?.metadata?.error_type ?? data.error?.type ?? 'error';
      // 404 unknown model, 408/5xx down: another model may answer. 400/401/402/403/429 would fail the same way.
      throw new UpstreamError(res.status, String(kind).slice(0, 60), res.status === 404 || res.status === 408 || res.status >= 500);
    }
    const choice = data.choices?.[0];
    if (!choice?.message) throw new UpstreamError(res.status, 'no_choice', true);
    const content = choice.message.content ?? '';
    const u = data.usage;
    return {
      model: data.model ?? req.model,
      content: req.json ? unfence(content) : content,
      tool_calls: (choice.message.tool_calls ?? [])
        .filter((t) => t.function?.name)
        .map((t) => ({ name: t.function!.name!, arguments: parseArgs(t.function!.arguments) })),
      finish_reason: choice.finish_reason ?? null,
      usage:
        u && Number.isInteger(u.prompt_tokens) && Number.isInteger(u.completion_tokens)
          ? { input_tokens: u.prompt_tokens!, output_tokens: u.completion_tokens! }
          : null,
    };
  };
}
export type VultrChat = ReturnType<typeof createVultrClient>;
