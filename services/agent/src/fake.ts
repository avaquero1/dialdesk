import { AGENT, BLOCKED_CHAT_LINE, BOARD, newId, type ChatTurn, type ToolChip, type WidgetDraft } from '@app/contracts';
import { checkChat } from '@app/guard';
import { HttpError, clientFromEnv, now, type Call, type Handlers } from '@app/service-kit';

export interface FakeDeps {
  /** When set, propose_widget really stores a pending proposal in board. */
  board?: Call;
}
export async function fakeDepsFromEnv(): Promise<FakeDeps> {
  return process.env.AGENT_TOKEN_BOARD ? { board: await clientFromEnv('agent', 'board') } : {};
}

const CHIEFS_NEWS: WidgetDraft = {
  kind: 'display',
  type: 'news',
  title: 'Chiefs at Bills news',
  market_ids: ['kalshi:KXNFLGAME-26NOV08KCBUF-KC', 'polymarket:nfl-kc-buf-2026-11-08'],
  params: { team: 'Bills', event_keys: ['nfl-2026w10-kc-buf'] },
};

/**
 * The scripted chat from planning/ui/PLAN.md. No model call: the real agent uses models with role `chat` and the
 * tools in AGENT_TOOLS. Every reply still passes packages/guard, so "advice-test" shows the blocked line.
 */
export function fake(deps: FakeDeps = {}): Handlers<typeof AGENT> {
  const convs = new Map<string, { account_id: string; turns: ChatTurn[] }>();

  async function reply(account_id: string, message: string): Promise<{ text: string; chips: ToolChip[] }> {
    const m = message.toLowerCase();
    if (m.includes('advice-test')) return { text: 'You should buy YES. It is a sure thing.', chips: [] };
    if (/\bshould i\b|\bbuy\b|\bsell\b/.test(m))
      return { text: 'I do math, not calls. The market says 61%, up 4 points since yesterday. Want a widget for this market?', chips: [] };
    if (/warmer|cooler|hue \d+|\blight\b|\bdark\b|\bsystem\b/.test(m)) {
      const hue = m.includes('warmer') ? 32 : m.includes('cooler') ? 210 : Number(/hue (\d+)/.exec(m)?.[1] ?? NaN);
      const args = Number.isFinite(hue) ? { hue } : { mode: /dark/.test(m) ? 'dark' : /light/.test(m) ? 'light' : 'system' };
      const label = 'hue' in args ? `set_look · hue ${args.hue}°` : `set_look · ${args.mode}`;
      return { text: 'Done.', chips: [{ tool: 'set_look', args, status: 'applied', proposal_id: null, label }] };
    }
    if (/chiefs|bills|nba|nfl/.test(m)) {
      let proposal_id: string | null = null;
      if (deps.board) {
        const p = await deps.board(BOARD.propose, { params: { account_id }, body: { changes: [{ op: 'add', widget: CHIEFS_NEWS }] } });
        proposal_id = p.proposal_id;
      }
      return {
        text: 'I made a widget for that. Add it?',
        chips: [{ tool: 'propose_widget', args: { widgets: [CHIEFS_NEWS] }, status: 'proposed', proposal_id, label: 'Chiefs at Bills news' }],
      };
    }
    return { text: "Hi. Tell me your teams and markets, and I'll build your board.", chips: [] };
  }

  return {
    chat: async ({ body }) => {
      let id = body.conversation_id;
      if (id && convs.get(id)?.account_id !== body.account_id) throw new HttpError(400, 'bad_conversation', 'not your conversation');
      if (!id) {
        id = newId('cnv');
        convs.set(id, { account_id: body.account_id, turns: [] });
      }
      const conv = convs.get(id)!;
      conv.turns.push({ turn_id: newId('trn'), role: 'user', text: body.message, chips: [], verdict_id: null, at: now() });
      const r = await reply(body.account_id, body.message);
      const verdict = checkChat(r.text);
      const turn: ChatTurn = {
        turn_id: newId('trn'),
        role: 'agent',
        text: verdict.outcome === 'pass' ? r.text : BLOCKED_CHAT_LINE,
        chips: verdict.outcome === 'pass' ? r.chips : [],
        verdict_id: verdict.verdict_id,
        at: now(),
      };
      conv.turns.push(turn);
      return { conversation_id: id, turn };
    },
    getConversation: ({ params, query }) => {
      const c = convs.get(params.conversation_id);
      if (!c || c.account_id !== query.account_id) throw new HttpError(404, 'not_found', 'no such conversation');
      return { conversation_id: params.conversation_id, turns: c.turns };
    },
  };
}
