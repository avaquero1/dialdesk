/**
 * The real agent: the chat loop on models' `chat` role with the six function tools (AGENT_TOOLS, not MCP).
 * Flow D: the model writes a reply with slots, code fills them from markets quotes and board receipts, the whole reply
 * (and every title it proposes) passes packages/guard, and it goes out whole. A blocked reply becomes the fixed line and
 * changes nothing: board proposals are sent only after the guard passes, and the user's tap accepts them.
 * History lives in Postgres (schema `agent`); the model reads its own past templates, never a filled value.
 */
import { createHash } from 'node:crypto';
import {
  AGENT,
  BLOCKED_CHAT_LINE,
  BOARD,
  MARKETS,
  MODELS,
  agentToolDefs,
  newId,
  type ChatTurn,
  type CompleteBody,
  type Completion,
  type Verdict,
} from '@app/contracts';
import { checkChat } from '@app/guard';
import { CallError, HttpError, MemoryBus, busFromConfig, clientFromEnv, createLogger, logEntry, now, type Bus, type Call, type Handlers, type Logger } from '@app/service-kit';
import { RULES, boardForModel, dataBlock, marketsForModel } from './prompt.ts';
import { Slots, digitsIn, forHistory, strayDigits } from './slots.ts';
import { MemoryConversationStore, PgConversationStore, connect, type ConversationStore, type StoredTurn } from './store.ts';
import { runTool, type ProposalChange, type TurnState } from './tools.ts';

/** Checks a whole reply. Layer one by default; main wires layer two (the guard model) when packages/guard has it. */
export type ChatGuard = (text: string, account_id: string) => Promise<Verdict>;

export interface RealDeps {
  models: Call;
  board: Call;
  markets: Call;
  store: ConversationStore;
  bus: Bus;
  guard?: ChatGuard;
  log?: Logger;
}

/** Model calls per turn: tool rounds plus the final answer. */
export const MAX_STEPS = 4;
/** Past turns the model reads back. */
export const HISTORY_TURNS = 12;
export const MODEL_DOWN_LINE = "I can't reach the model right now. Try again in a minute.";
export const CAP_LINE = "The chat has used today's budget. It comes back after midnight UTC.";
const NO_ANSWER_LINE = "I couldn't finish that. Try asking another way.";

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** From env: AGENT_DATABASE_URL, AGENT_VALKEY_URL, AGENT_TOKEN_MODELS / _BOARD / _MARKETS (and their _URL_). */
export async function real(cfg: Record<string, unknown>): Promise<Handlers<typeof AGENT>> {
  const log = createLogger('agent');
  const url = typeof cfg.DATABASE_URL === 'string' && cfg.DATABASE_URL ? cfg.DATABASE_URL : null;
  if (!url) log.warn('no AGENT_DATABASE_URL: conversations are kept in memory');
  const valkey = typeof cfg.VALKEY_URL === 'string' && cfg.VALKEY_URL ? cfg.VALKEY_URL : undefined;
  if (!valkey) log.warn('no AGENT_VALKEY_URL: the log stream stays in memory');
  return createReal({
    models: await clientFromEnv('agent', 'models'),
    board: await clientFromEnv('agent', 'board'),
    markets: await clientFromEnv('agent', 'markets'),
    store: url ? new PgConversationStore(connect(url)) : new MemoryConversationStore(),
    bus: valkey ? busFromConfig('agent', { VALKEY_URL: valkey }) : new MemoryBus(),
    log,
  });
}

export function createReal(deps: RealDeps): Handlers<typeof AGENT> {
  const guard: ChatGuard = deps.guard ?? (async (text) => checkChat(text));
  const log = deps.log ?? createLogger('agent', 'silent');

  async function context(account_id: string, widget_id: string | null, message: string) {
    const b = await deps.board(BOARD.getBoard, { params: { account_id } }).catch((e) => {
      if (e instanceof CallError && e.status === 404) return { account_id, widgets: [], pending: [] };
      throw e;
    });
    const board = boardForModel(b);
    let tune = null;
    if (widget_id) {
      const w = board.find((x) => x.widget_id === widget_id);
      if (!w) throw new HttpError(400, 'bad_widget', 'no such widget on this board');
      const brief = b.widgets.find((x) => x.spec.widget_id === widget_id)?.profile?.brief ?? null;
      tune = { widget: w, brief };
    }
    // The public listing; an exchange outage leaves the list empty, it doesn't fail the chat.
    const all = await deps.markets(MARKETS.list, { query: { category: 'sports' } }).then(
      (r) => r.markets,
      () => [],
    );
    const markets = marketsForModel(all, message);
    return { board, data: dataBlock({ board, pending: b.pending.length, markets, tune }), names: [...board.map((w) => w.title), ...markets.map((m) => m.title)] };
  }

  async function complete(body: CompleteBody): Promise<Completion | 'cap' | 'down'> {
    try {
      return await deps.models(MODELS.complete, { body });
    } catch (e) {
      if (e instanceof CallError && e.status === 429) throw new HttpError(429, 'rate_limited', 'too many chat turns; wait a minute');
      if (e instanceof CallError && e.status === 402) return 'cap';
      log.warn({ err: e instanceof CallError ? `${e.status} ${e.body.error}` : (e as Error).name }, 'chat model call failed');
      return 'down';
    }
  }

  /** The loop: model, tools, model… until it answers in words or MAX_STEPS. Returns the model's template. */
  async function loop(st: TurnState, messages: CompleteBody['messages']): Promise<{ template: string; fixed: boolean; steps: number }> {
    const tools = agentToolDefs();
    for (let step = 1; step <= MAX_STEPS; step++) {
      const r = await complete({ role: 'chat', account_id: st.account_id, messages, tools, max_tokens: 600 });
      if (r === 'cap') return { template: CAP_LINE, fixed: true, steps: step };
      if (r === 'down') return { template: MODEL_DOWN_LINE, fixed: true, steps: step };
      if (!r.tool_calls.length) {
        const text = r.content.trim();
        return { template: text || (st.chips.length ? 'Done.' : NO_ANSWER_LINE), fixed: !text, steps: step };
      }
      messages.push({ role: 'assistant', content: `${r.content.trim()}\n(called: ${r.tool_calls.map((c) => c.name.slice(0, 40)).join(', ')})`.trim() });
      for (const c of r.tool_calls) {
        const result = await runTool(c.name, c.arguments, st, deps);
        messages.push({ role: 'tool', tool_name: c.name.slice(0, 40), content: JSON.stringify(result) });
      }
    }
    return { template: st.chips.length ? 'Done.' : NO_ANSWER_LINE, fixed: true, steps: MAX_STEPS };
  }

  /** Sends the pending changes to board, one proposal per chip. A refusal there turns the chip refused. */
  async function propose(st: TurnState) {
    for (const [i, changes] of st.pending) {
      const chip = st.chips[i]!;
      try {
        const p = await deps.board(BOARD.propose, { params: { account_id: st.account_id }, body: { changes: changes as never } });
        chip.proposal_id = p.proposal_id;
      } catch (e) {
        if (!(e instanceof CallError) || (e.status !== 400 && e.status !== 404)) throw e;
        chip.status = 'refused';
        st.refused++;
      }
    }
  }

  return {
    chat: async ({ body }) => {
      const { account_id, message } = body;
      let id = body.conversation_id;
      let widget_id = body.widget_id;
      if (id) {
        const c = await deps.store.get(id);
        if (!c || c.account_id !== account_id) throw new HttpError(400, 'bad_conversation', 'not your conversation');
        if (widget_id && c.widget_id !== widget_id) throw new HttpError(400, 'bad_conversation', 'this conversation belongs to another widget');
        widget_id = c.widget_id;
      }
      const ctx = await context(account_id, widget_id, message);
      if (!id) {
        id = newId('cnv');
        await deps.store.create({ conversation_id: id, account_id, widget_id });
      }
      const history = await deps.store.turns(id, HISTORY_TURNS);
      const userTurn: StoredTurn = { turn_id: newId('trn'), role: 'user', text: message, template: null, chips: [], verdict_id: null, at: now() };
      await deps.store.append(id, userTurn);

      const st: TurnState = {
        account_id,
        widget_id,
        board: ctx.board,
        userTexts: [...history.filter((t) => t.role === 'user').map((t) => t.text), message],
        slots: new Slots(),
        chips: [],
        pending: new Map<number, ProposalChange[]>(),
        shown: [],
        settingDigits: new Set(),
        seen: new Set(),
        calls: 0,
        refused: 0,
      };
      const messages: CompleteBody['messages'] = [
        { role: 'system', content: `${RULES}\n\n${ctx.data}` },
        ...history.map((t) => (t.role === 'user' ? { role: 'user' as const, content: t.text } : { role: 'assistant' as const, content: forHistory(t.template ?? t.text) })),
        { role: 'user', content: message },
      ];
      const { template, fixed, steps } = await loop(st, messages);

      // Numbers: slots filled by code; a digit the model typed itself blocks the reply.
      const filled = st.slots.fill(template);
      const allowed = new Set([...digitsIn([...st.userTexts, ...ctx.names]), ...st.settingDigits]);
      const stray = fixed ? [] : [...strayDigits(template, allowed), ...st.shown.flatMap((s) => strayDigits(s, allowed))];
      const labels = st.chips.filter((c) => c.status !== 'refused').map((c) => c.label);
      const g = await guard([filled.text, ...labels, ...st.shown].filter(Boolean).join('\n'), account_id);
      const extra: Verdict['reasons'] = [
        ...(stray.length ? [{ code: 'bare_digit' as const, where: 'reply' }] : []),
        ...filled.missing.map((n) => ({ code: 'missing_receipt' as const, where: `reply.slots.${n}` })),
      ];
      const verdict: Verdict = extra.length ? { ...g, outcome: 'block', reasons: [...g.reasons, ...extra] } : g;
      const pass = verdict.outcome === 'pass';
      if (pass) await propose(st);

      const turn: ChatTurn = {
        turn_id: newId('trn'),
        role: 'agent',
        text: (pass ? filled.text : BLOCKED_CHAT_LINE).slice(0, 4000),
        chips: pass ? st.chips : [],
        verdict_id: verdict.verdict_id,
        at: now(),
      };
      await deps.store.append(id, { ...turn, template: pass ? template : BLOCKED_CHAT_LINE });
      const proposals = turn.chips.filter((c) => c.proposal_id).map((c) => c.proposal_id!);
      await deps.bus.log(
        logEntry('agent', 'chat.turn', {
          account_id,
          subject_id: id,
          outcome: pass ? 'ok' : 'blocked',
          ids: {
            conversation_id: id,
            turn_id: turn.turn_id,
            verdict_id: verdict.verdict_id,
            ...(widget_id && { widget_id }),
            ...(proposals.length && { proposal_ids: proposals.join(',').slice(0, 120) }),
          },
          hashes: { message: sha256(message), reply: sha256(turn.text) },
          sizes: { message_chars: message.length, reply_chars: turn.text.length, model_calls: steps, tool_calls: st.calls, refused: st.refused, chips: turn.chips.length },
        }),
      );
      log.info({ conversation_id: id, verdict: verdict.outcome, reasons: verdict.reasons.map((r) => r.code), tool_calls: st.calls, refused: st.refused }, 'chat turn');
      return { conversation_id: id, turn };
    },

    getConversation: async ({ params, query }) => {
      const c = await deps.store.get(params.conversation_id);
      if (!c || c.account_id !== query.account_id) throw new HttpError(404, 'not_found', 'no such conversation');
      const turns = await deps.store.turns(c.conversation_id);
      return { conversation_id: c.conversation_id, turns: turns.map(({ template: _t, ...t }) => t) };
    },
  };
}
