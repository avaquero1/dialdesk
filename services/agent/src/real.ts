/**
 * The real agent: the chat loop on models' `chat` role with the six function tools (AGENT_TOOLS, not MCP).
 * Flow D: the model writes a reply with slots, code fills them from markets quotes and board receipts, the whole reply
 * (and every title it proposes) passes packages/guard, and it goes out whole. A blocked reply becomes the fixed line and
 * changes nothing: board proposals are sent only after the guard passes, and the user's tap accepts them. A stray digit
 * with nothing else wrong gets one more go; if the digit is still there, a line code writes and the proposals free of one.
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
import { checkChat, guardChatReply } from '@app/guard';
import { CallError, HttpError, MemoryBus, busFromConfig, clientFromEnv, createLogger, followAccountDeletes, logEntry, now, type Bus, type Call, type Handlers, type Logger } from '@app/service-kit';
import { picksFor } from './picks.ts';
import { changeTexts, fixWidgetCount, withSaid } from './reply.ts';
import { RULES, boardForModel, dataBlock, marketsForModel } from './prompt.ts';
import { Slots, boardMoves, digitsIn, forHistory, strayDigits } from './slots.ts';
import { MemoryConversationStore, PgConversationStore, connect, type ConversationStore, type StoredTurn } from './store.ts';
import { runTool, type ProposalChange, type TurnState } from './tools.ts';

/** Checks a whole reply. Default: both layers (guardChatReply, layer two through models' guard role); it fails closed. */
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
/** The history's note beside a tool call. It names no tool: the model copied "(called: propose_widget)" as its reply, and the guard read the name as an order. */
export const TOOL_NOTE = '(used a tool, result below)';
/** A reply the model couldn't write without a digit nobody gave it: code writes these, and no digit is in them. */
export const NEUTRAL_LINE = "Here's what I can add for you. Tap one to add it.";
export const NEUTRAL_PICKS_LINE = "Tap a league or a team and I'll line up what I can add.";
/** The one retry's note. It holds no digit of its own. */
export const NO_DIGITS_NOTE = "Write your answer again. Your last try typed a date, a time or a count in digits, and the app can't show that. Write no digits at all, in your reply or in any widget title or brief, except inside a team's or a market's own name. For a market's number use a slot from a tool. Leave out dates and times.";

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** From env: AGENT_DATABASE_URL, AGENT_VALKEY_URL, AGENT_TOKEN_MODELS / _BOARD / _MARKETS (and their _URL_). */
export async function real(cfg: Record<string, unknown>): Promise<Handlers<typeof AGENT>> {
  const log = createLogger('agent');
  const url = typeof cfg.DATABASE_URL === 'string' && cfg.DATABASE_URL ? cfg.DATABASE_URL : null;
  if (!url) log.warn('no AGENT_DATABASE_URL: conversations are kept in memory');
  const valkey = typeof cfg.VALKEY_URL === 'string' && cfg.VALKEY_URL ? cfg.VALKEY_URL : undefined;
  if (!valkey) log.warn('no AGENT_VALKEY_URL: the log stream stays in memory');
  const store = url ? new PgConversationStore(connect(url)) : new MemoryConversationStore();
  const bus = valkey ? busFromConfig('agent', { VALKEY_URL: valkey }) : new MemoryBus();
  // A deleted account (the nightly guest sweep) takes its conversations with it; the orphan sweep catches a missed event.
  if (valkey) await followAccountDeletes({ service: 'agent', bus, data: store, accounts: await clientFromEnv('agent', 'accounts'), log });
  return createReal({
    models: await clientFromEnv('agent', 'models'),
    board: await clientFromEnv('agent', 'board'),
    markets: await clientFromEnv('agent', 'markets'),
    store,
    bus,
    log,
  });
}

export function createReal(deps: RealDeps): Handlers<typeof AGENT> {
  const guard: ChatGuard = deps.guard ?? (async (text, account_id) => (await guardChatReply(text, { models: deps.models, account_id })).verdict);
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
    return { board, moves: boardMoves(b.widgets.map((w) => w.result)), all, data: dataBlock({ board, pending: b.pending.length, markets, tune }), names: [...board.map((w) => w.title), ...markets.map((m) => m.title)] };
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
    // The JSON Schema's own "$schema" URL carries digits and tells the model nothing.
    const tools = agentToolDefs().map(({ parameters: { $schema: _s, ...parameters }, ...t }) => ({ ...t, parameters }));
    // Text the model wrote beside its tool calls ("I do math, not calls." beside quote_market): kept for the reply.
    const said: string[] = [];
    for (let step = 1; step <= MAX_STEPS; step++) {
      const r = await complete({ role: 'chat', account_id: st.account_id, messages, tools, max_tokens: 600 });
      if (r === 'cap') return { template: CAP_LINE, fixed: true, steps: step };
      if (r === 'down') return { template: MODEL_DOWN_LINE, fixed: true, steps: step };
      // The note belongs to the history: a model that copies it has said nothing.
      const content = r.content.replaceAll(TOOL_NOTE, '').trim();
      if (!r.tool_calls.length) {
        const text = withSaid(said, content);
        return { template: text || (st.chips.length ? 'Done.' : NO_ANSWER_LINE), fixed: !text, steps: step };
      }
      said.push(content);
      messages.push({ role: 'assistant', content: `${content}\n${TOOL_NOTE}`.trim() });
      for (const c of r.tool_calls) {
        const result = await runTool(c.name, c.arguments, st, deps);
        messages.push({ role: 'tool', tool_name: c.name.slice(0, 40), content: JSON.stringify(result) });
      }
    }
    const text = withSaid(said, '');
    return { template: text || (st.chips.length ? 'Done.' : NO_ANSWER_LINE), fixed: !text, steps: MAX_STEPS };
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

      const base: CompleteBody['messages'] = [
        { role: 'system', content: `${RULES}\n\n${ctx.data}` },
        ...history.map((t) => (t.role === 'user' ? { role: 'user' as const, content: t.text } : { role: 'assistant' as const, content: forHistory(t.template ?? t.text) })),
        { role: 'user', content: message },
      ];

      /** One go at the turn: fresh state, the loop, and every check that needs no model. Nothing is proposed here. */
      const attempt = async (messages: CompleteBody['messages']) => {
        const st: TurnState = {
          account_id,
          widget_id,
          board: ctx.board,
          moves: ctx.moves,
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
        const { template: raw, fixed, steps } = await loop(st, [...messages]);
        // Words that claim more widgets than the chips propose are rewritten by code from the chips.
        const counted = fixed ? { text: raw, fixed: 0 } : fixWidgetCount(raw, st.chips);
        const template = counted.text;
        // Numbers: slots filled by code; a digit the model typed itself never reaches the screen.
        const filled = st.slots.fill(template);
        const allowed = new Set([...digitsIn([...st.userTexts, ...ctx.names]), ...st.settingDigits]);
        const strayReply = fixed ? [] : strayDigits(template, allowed);
        // The titles and briefs count even under a line code wrote ("Done."): the chips still show them.
        const strayShown = st.shown.flatMap((s) => strayDigits(s, allowed));
        // One check over everything the model wrote that the user will read: the reply, and the titles and briefs it
        // proposed. Chip labels are code (a tool name plus validated values or those titles), and the guard reads a tool
        // name as an order aimed at an agent, so they aren't sent.
        const shownText = [filled.text, ...st.shown].filter(Boolean).join('\n');
        const layerOne = checkChat(shownText);
        const stray = [...strayReply, ...strayShown];
        return { st, steps, counted, template, filled, allowed, strayReply, strayShown, stray, shownText, layerOne, digitOnly: stray.length > 0 && !filled.missing.length && layerOne.outcome === 'pass' };
      };

      // A stray digit and nothing else wrong: one more go with a short note. Advice, orders, secrets and a missing
      // receipt never get one. A retry the model couldn't answer (cap, down, rate limit) leaves the first go standing.
      const first = await attempt(base);
      const second = first.digitOnly ? await attempt([...base, { role: 'user', content: NO_DIGITS_NOTE }]).catch((e) => {
        if (e instanceof HttpError && e.status === 429) return null;
        throw e;
      }) : null;
      const last = second && (second.template !== MODEL_DOWN_LINE && second.template !== CAP_LINE && (second.template !== NO_ANSWER_LINE || second.st.chips.length > 0)) ? second : first;
      const tries = second ? [first, second] : [first];
      const { st, counted, template, filled } = last;

      // Still a stray digit after that: a line code writes, and only what has no stray digit of its own.
      const neutral = last.digitOnly;
      const dropped = new Set<number>();
      if (neutral)
        st.chips.forEach((c, i) => {
          if (c.status === 'refused' || changeTexts(st.pending.get(i) ?? []).some((s) => strayDigits(s, last.allowed).length)) {
            dropped.add(i);
            st.pending.delete(i);
          }
        });
      const keptText = neutral ? [...st.pending.values()].flatMap(changeTexts).filter(Boolean).join('\n') : '';

      const extra: Verdict['reasons'] = neutral
        ? []
        : [...(last.stray.length ? [{ code: 'bare_digit' as const, where: 'reply' }] : []), ...filled.missing.map((n) => ({ code: 'missing_receipt' as const, where: `reply.slots.${n}` }))];
      // Already blocked by its numbers: layer one only. The neutral line is code, so only the proposals kept need the model.
      const g = extra.length ? last.layerOne : neutral && !keptText ? checkChat(NEUTRAL_LINE) : await guard(neutral ? keptText : last.shownText, account_id);
      const verdict: Verdict = extra.length ? { ...g, outcome: 'block', reasons: [...g.reasons, ...extra] } : g;
      const pass = verdict.outcome === 'pass';
      if (pass) await propose(st);

      // The first visit: leagues, then teams, to tap. Written by code from the listing, never by the model.
      const kept = st.chips.filter((_, i) => !dropped.has(i));
      // Under the neutral line a read-only chip (a quote) doesn't hold back the picks.
      const picks = pass ? picksFor({ message, userTexts: st.userTexts.slice(0, -1), markets: ctx.all, tune: !!widget_id, chips: neutral ? st.pending.size : kept.length }) : undefined;
      const neutralLine = st.pending.size ? NEUTRAL_LINE : picks ? NEUTRAL_PICKS_LINE : NO_ANSWER_LINE;
      const turn: ChatTurn = {
        turn_id: newId('trn'),
        role: 'agent',
        text: (pass ? (neutral ? neutralLine : filled.text) : BLOCKED_CHAT_LINE).slice(0, 4000),
        chips: pass ? kept : [],
        ...(picks && { picks }),
        verdict_id: verdict.verdict_id,
        at: now(),
      };
      await deps.store.append(id, { ...turn, template: pass ? (neutral ? neutralLine : template) : BLOCKED_CHAT_LINE });
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
          sizes: { message_chars: message.length, reply_chars: turn.text.length, model_calls: tries.reduce((n, t) => n + t.steps, 0), tool_calls: tries.reduce((n, t) => n + t.st.calls, 0), refused: st.refused, chips: turn.chips.length, count_fixed: counted.fixed, retried: tries.length - 1 },
        }),
      );
      log.info({ conversation_id: id, verdict: verdict.outcome, reasons: verdict.reasons.map((r) => r.code), tool_calls: st.calls, refused: st.refused, ...(tries.some((t) => t.stray.length) && { stray_reply: tries.flatMap((t) => t.strayReply), stray_shown: tries.flatMap((t) => t.strayShown), repair: neutral ? 'neutral' : second ? 'retry' : 'none' }) }, 'chat turn');
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
