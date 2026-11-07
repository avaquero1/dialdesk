import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PRICES } from '../src/prices.ts';

/**
 * A local mock of Vultr Serverless Inference (https://api.vultrinference.com/docs): POST /v1/chat/completions in the
 * OpenAI shape, the error payload `{error: {code, message, type, metadata: {error_type}}}`, and bearer auth.
 * Tests steer it: `down` models answer 503, `rateLimited` answers 429, `delayMs` slows every answer.
 */
export interface MockVultr {
  url: string;
  /** Request bodies it received, in order (the Authorization header is checked, never stored). */
  requests: Record<string, any>[];
  down: Set<string>;
  rateLimited: boolean;
  delayMs: number;
  /** Leave `usage` out of the answers. */
  noUsage: boolean;
  /** Bill every answer at its full max_tokens (to spend a cap quickly). */
  fullOutput: boolean;
  close(): Promise<void>;
}

const err = (code: number, type: string, message: string) => ({ error: { code, message, type, metadata: { error_type: type } } });

async function readBody(req: IncomingMessage): Promise<string> {
  let s = '';
  for await (const chunk of req) s += chunk;
  return s;
}

export async function startMockVultr(expectedKey: string): Promise<MockVultr> {
  const mock: Omit<MockVultr, 'url' | 'close'> = { requests: [], down: new Set(), rateLimited: false, delayMs: 0, noUsage: false, fullOutput: false };
  let n = 0;
  const server: Server = createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && req.url === '/v1/health') return send(200, { status: 'ok' });
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return send(404, err(404, 'not_found', 'no such route'));
    if (req.headers.authorization !== `Bearer ${expectedKey}`) return send(401, err(401, 'unauthorized', 'bad key'));
    let b: Record<string, any>;
    try {
      b = JSON.parse(await readBody(req));
    } catch {
      return send(400, err(400, 'invalid_request', 'body is not JSON'));
    }
    mock.requests.push(b);
    if (mock.delayMs) await new Promise((r) => setTimeout(r, mock.delayMs));
    if (!b.model || !PRICES[b.model]) return send(404, err(404, 'model_not_found', `no model ${b.model}`));
    if (mock.rateLimited) return send(429, err(429, 'rate_limit_exceeded', 'slow down'));
    if (mock.down.has(b.model)) return send(503, err(503, 'models_unavailable', 'model is down'));
    if (!Array.isArray(b.messages) || !b.messages.length) return send(400, err(400, 'invalid_request', 'messages'));

    const last = String(b.messages.at(-1)?.content ?? '');
    let content = 'Hello from the mock.';
    let tool_calls: unknown[] | undefined;
    if (b.tools?.length && /chiefs/i.test(last)) {
      content = '';
      tool_calls = [{ id: `call_${++n}`, type: 'function', function: { name: b.tools[0].function.name, arguments: JSON.stringify({ widgets: [] }) } }];
    } else if (b.response_format?.type === 'json_object') {
      // One model fences its JSON, as some real ones do.
      content = b.model === 'qwen3.8-27b' ? '```json\n{"ok":true}\n```' : '{"ok":true}';
    }
    const prompt_tokens = Math.ceil(b.messages.reduce((s: number, m: { content: string }) => s + String(m.content).length, 0) / 4) + 4;
    const completion_tokens = mock.fullOutput ? (b.max_tokens ?? 1024) : Math.min(b.max_tokens ?? 1e9, Math.ceil(content.length / 4) + (tool_calls ? 20 : 1));
    send(200, {
      id: `chatcmpl-${++n}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: b.model,
      choices: [{ index: 0, message: { role: 'assistant', content, ...(tool_calls && { tool_calls }) }, finish_reason: tool_calls ? 'tool_calls' : 'stop' }],
      ...(!mock.noUsage && { usage: { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens } }),
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return Object.assign(mock, {
    url: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  });
}
