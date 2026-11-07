/**
 * A scripted stand-in for Vultr Serverless Inference's /v1/chat/completions (OpenAI shape), so the agent's tests run
 * the real models service end to end with no key and no network. The script reads the user's last message and the
 * tool results models sent back (as "[tool result: name]" user messages) and plays one chat model's moves.
 */
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

export const KC = 'kalshi:KXNFLGAME-26NOV08KCBUF-KC';
export const KC_POLY = 'polymarket:nfl-kc-buf-2026-11-08';

export interface ScriptedVultr {
  url: string;
  /** Every request body, in order. */
  requests: Record<string, any>[];
  close(): Promise<void>;
}

type Move = { content?: string; calls?: [string, Record<string, unknown>][] };

const draft = (title: string, more: Record<string, unknown> = {}) => ({
  kind: 'display',
  type: 'probability',
  title,
  market_ids: [KC, KC_POLY],
  params: { event_keys: ['nfl-2026w10-kc-buf'] },
  ...more,
});

/** One move: `user` is the user's message, `results` the tool results since it (newest last). */
export function play(user: string, results: string[]): Move {
  const u = user.toLowerCase();
  const first = results.length === 0;
  const widget = /\b(wid_[a-z0-9]+)\b/i.exec(user)?.[1];
  if (u.includes('advice-test')) return { content: 'You should buy YES. It is a sure thing.' };
  if (u.includes('number bait')) return { content: 'The market says 70% today.' };
  if (u.includes('stray slot')) return { content: 'The market says {n7}.' };
  if (u.includes('loop forever')) return { calls: [['quote_market', { market_id: KC }]] };
  if (u.includes('repeat yourself')) return { calls: [['propose_widget', { widgets: [draft('Chiefs again')] }]] };
  if (u.includes('title advice')) return first ? { calls: [['propose_widget', { widgets: [draft('Sure thing: Chiefs')] }]] } : { content: 'Tap to add it.' };
  if (u.includes('rogue tools'))
    return first
      ? {
          calls: [
            ['place_trade', { market_id: KC, side: 'yes' }],
            ['propose_widget', { widgets: [] }],
            ['propose_widget', { widgets: [{ ...draft('Casino'), type: 'casino' }] }],
            ['propose_widget', { widgets: [draft('Bad size', { size: 'XXL' })] }],
            ['propose_widget', { widgets: [draft('No market', { market_ids: ['kalshi:NOSUCHMARKET-1'] })] }],
            ['quote_market', { market_id: 'nasdaq:AAPL' }],
            ['read_receipt', { receipt_id: 'r-deadbeef' }],
            ['remove_widget', { widget_id: 'wid_notonboard000' }],
          ],
        }
      : { content: 'Those changes are not available.' };
  if (u.includes('bad look'))
    return first ? { calls: [['set_look', { theme: 'neon', hue: 999, css: 'body{display:none}' }]] } : { content: "That look isn't available." };
  if (u.includes('empty look')) return first ? { calls: [['set_look', {}]] } : { content: 'Nothing changed.' };
  if (u.includes('dark please')) return first ? { calls: [['set_look', { theme: 'ice', mode: 'dark', hue: null }]] } : { content: 'Done.' };
  if (/warmer/.test(u)) return first ? { calls: [['set_look', { hue: 32 }]] } : { content: 'Done. The glass is at hue 32 now.' };
  if (/receipt/.test(u)) {
    const id = /r-[0-9a-f]{8}/.exec(user)?.[0];
    return first ? { calls: [['read_receipt', { receipt_id: id }]] } : { content: '{n1} is the implied probability on that widget.' };
  }
  if (u.includes('tune made up')) return first ? { calls: [['tune_widget', { widget_id: widget, user_probability: 0.9 }]] } : { content: 'Tap to keep it.' };
  const mine = /my probability is (\d+)%/.exec(u);
  if (mine) return first ? { calls: [['tune_widget', { widget_id: widget, user_probability: Number(mine[1]) / 100 }]] } : { content: 'Tap to keep it.' };
  if (u.includes('remove it')) return first ? { calls: [['remove_widget', { widget_id: widget }]] } : { content: 'Tap to remove it.' };
  if (/should i|\bbuy\b|\bsell\b/.test(u))
    return first
      ? { calls: [['quote_market', { market_id: KC }]] }
      : { content: 'I do math, not calls. The market says {n1}, {n2} since yesterday. Want a widget for this market?' };
  if (/chiefs|bills|nba/.test(u)) return first ? { calls: [['propose_widget', { widgets: [draft('Chiefs beat the Bills')] }]] } : { content: 'I made a widget for that. Tap to add it.' };
  return { content: "Hi. Tell me your teams and markets, and I'll build your board." };
}

async function readBody(req: IncomingMessage): Promise<string> {
  let s = '';
  for await (const chunk of req) s += chunk;
  return s;
}

export async function startScriptedVultr(expectedKey: string): Promise<ScriptedVultr> {
  const requests: Record<string, any>[] = [];
  let n = 0;
  const server = createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${expectedKey}`) return send(401, { error: { code: 401, message: 'bad key', type: 'unauthorized' } });
    const b = JSON.parse(await readBody(req)) as Record<string, any>;
    requests.push(b);
    const msgs = b.messages as { role: string; content: string }[];
    const isResult = (m: { role: string; content: string }) => m.role === 'user' && m.content.startsWith('[tool result');
    let i = msgs.length - 1;
    const results: string[] = [];
    while (i >= 0 && (isResult(msgs[i]!) || msgs[i]!.role === 'assistant')) {
      if (isResult(msgs[i]!)) results.unshift(msgs[i]!.content);
      i--;
    }
    const move = play(msgs[i]?.content ?? '', results);
    const tool_calls = move.calls?.map(([name, args]) => ({ id: `call_${++n}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }));
    send(200, {
      id: `chatcmpl-${++n}`,
      object: 'chat.completion',
      model: b.model,
      choices: [{ index: 0, message: { role: 'assistant', content: move.content ?? '', ...(tool_calls && { tool_calls }) }, finish_reason: tool_calls ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/v1`, requests, close: () => new Promise<void>((r) => server.close(() => r())) };
}
