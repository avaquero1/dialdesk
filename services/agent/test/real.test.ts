/**
 * The real agent, end to end in process: the real models service (real mode, against a scripted Vultr Inference on
 * localhost), board and markets fakes, memory history. The contract cases run in real mode, then the rules: advice
 * gets the fixed line, a number the model typed never reaches the screen (one retry, then a line code writes), tool calls are validated, set_look refuses bad
 * values, a blocked reply proposes nothing, and the model never reads page text or a number's value.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AGENT, AGENT_TOOLS, BLOCKED_CHAT_LINE, BOARD, MARKETS, MODELS, type Board, type ChatReply } from '@app/contracts';
import { MemoryBus, buildApp, createClient, createLogger } from '@app/service-kit';
import { fakeApp, runCase, sampleResult, testCallers, TEST_TOKENS, type Ctx } from '@app/testkit';
import { fake as boardFake } from '../../board/src/fake.ts';
import { fake as marketsFake } from '../../markets/src/fake.ts';
import { MemoryUsageStore } from '../../models/src/meter.ts';
import { real as modelsReal } from '../../models/src/real.ts';
import { createReal, MAX_STEPS, NEUTRAL_LINE, NEUTRAL_PICKS_LINE, NO_DIGITS_NOTE } from '../src/real.ts';
import { MemoryConversationStore } from '../src/store.ts';
import { cases } from './cases.ts';
import { KC, MADE_UP_PROBABILITY, startScriptedVultr, type ScriptedVultr } from './scripted-vultr.ts';
import { isUsersNumber } from '../src/tools.ts';

const KEY = `vtest_${randomBytes(24).toString('base64url')}`;
const dir = mkdtempSync(join(tmpdir(), 'agent-test-'));
const keyPath = join(dir, 'vultr-inference');
const ACC = 'acc_agentreal0001';
const CONTRACT_ACC = 'acc_contract0001';

type App = { fetch: (r: Request) => Response | Promise<Response> };
const as = (caller: keyof typeof TEST_TOKENS, app: App) => createClient({ baseUrl: 'http://svc.internal', token: TEST_TOKENS[caller], fetch: (r) => app.fetch(r) });

let vultr: ScriptedVultr;
let agentApp: ReturnType<typeof buildApp>;
let boardApp: ReturnType<typeof fakeApp>;
const bus = new MemoryBus();
let board: Board;
let probWidget: string;

const chat = async (message: string, conversation_id: string | null = null, widget_id: string | null = null, account_id = ACC) => {
  const res = await agentApp.request('/chat', {
    method: 'POST',
    headers: { authorization: `Bearer ${TEST_TOKENS.edge}`, 'content-type': 'application/json' },
    body: JSON.stringify({ account_id, conversation_id, widget_id, message }),
  });
  return { status: res.status, body: (await res.json()) as ChatReply & { error?: string } };
};
const boardOf = (account_id: string) => as('agent', boardApp)(BOARD.getBoard, { params: { account_id } });
const sentToModel = () => JSON.stringify(vultr.requests);
/** The chat role's requests (the guard role's layer-two calls left out). */
const chatCalls = () => vultr.requests.filter((q) => !String(q.messages[0]?.content).startsWith('You check text'));

beforeAll(async () => {
  writeFileSync(keyPath, `${KEY}\n`, { mode: 0o600 });
  vultr = await startScriptedVultr(KEY);
  const log = createLogger('test', 'silent');
  const models = buildApp({
    service: 'models',
    mode: 'real',
    api: MODELS,
    handlers: await modelsReal({ VULTR_KEY_FILE: keyPath, VULTR_BASE_URL: vultr.url, TIMEOUT_MS: '5000', ACCOUNT_RPM: '1000', ACCOUNT_DAILY_TOKENS: '100000000', ACCOUNT_DAILY_USD: '100', DAILY_CAP_USD: '100' }, { store: new MemoryUsageStore(), log }),
    callers: testCallers(),
    log,
  });
  const markets = fakeApp('markets', MARKETS, marketsFake());
  boardApp = fakeApp('board', BOARD, boardFake({ markets: as('board', markets) }));
  const handlers = createReal({ models: as('agent', models), board: as('agent', boardApp), markets: as('agent', markets), store: new MemoryConversationStore(), bus, log });
  agentApp = buildApp({ service: 'agent', mode: 'real', api: AGENT, handlers, callers: testCallers(), log });

  const edgeBoard = as('edge', boardApp);
  for (const account_id of [ACC, CONTRACT_ACC]) await edgeBoard(BOARD.createDefaults, { params: { account_id }, body: { category: 'sports' } });
  board = await boardOf(ACC);
  probWidget = board.widgets.find((w) => w.spec.kind === 'display' && w.spec.type === 'probability' && w.spec.title === 'Chiefs beat the Bills')!.spec.widget_id;
  // A run's result on that widget: receipts the agent may read, and page-derived text it must never see.
  const body = sampleResult(probWidget, ACC, 'pass');
  // The card's move since yesterday (the engine's, over 24 h): the one the chat must say.
  body.result.numbers.push({ id: 'n9', op: 'movement', value: -3, unit: 'points', receipt_id: 'r-0a1b2c3e' });
  body.result.receipts.push({ ...body.result.receipts[0]!, id: 'r-0a1b2c3e', op: 'movement', op_id: 'n9', value: -3, unit: 'points', formula: 'move = now_cents - then_cents', args: { window_s: 86400 }, provenance: { series: { source: KC, as_of: body.result.as_of } } });
  await as('runner', boardApp)(BOARD.putResult, { params: { widget_id: probWidget }, body });
});
afterAll(async () => {
  await vultr.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('agent real mode: the contract cases', () => {
  const ctx: Ctx = {};
  for (const c of cases)
    it(`${c.endpoint} ${c.label ?? ''}`.trim(), async () => {
      const out = await runCase(agentApp, AGENT, c, ctx);
      expect(out.problems).toEqual([]);
    });
});

describe('agent real mode: the rules', () => {
  it('sends the six tools to the chat role, and only those', () => {
    const names = chatCalls().at(-1)!.tools.map((t: { function: { name: string } }) => t.function.name).sort();
    expect(names).toEqual(Object.keys(AGENT_TOOLS).sort());
  });

  it('proposes a widget as pending; the board changes only on the click', async () => {
    const before = await boardOf(ACC);
    const r = await chat('Chiefs, Bills, and the NBA tonight.');
    expect(r.status).toBe(200);
    const chip = r.body.turn.chips[0]!;
    expect(chip).toMatchObject({ tool: 'propose_widget', status: 'proposed', label: 'Chiefs beat the Bills' });
    expect(chip.proposal_id).toMatch(/^prp_/);
    const after = await boardOf(ACC);
    expect(after.widgets.length).toBe(before.widgets.length);
    expect(after.pending.map((p) => p.proposal_id)).toContain(chip.proposal_id);
    expect(after.pending.find((p) => p.proposal_id === chip.proposal_id)!.changes[0]).toMatchObject({ op: 'add', widget: { type: 'probability', size: 'M' } });
  });

  it('answers a market question with the quote, filled by code, and no call', async () => {
    const r = await chat('should I buy YES on the Chiefs?');
    expect(r.body.turn.text).toMatch(/^I do math, not calls\. The market says \d+(\.\d)?%, (up [\d.]+ points?|down [\d.]+ points?|unchanged) since yesterday\. Want a widget for this market\?$/);
    expect(r.body.turn.text).toContain('down 3 points since yesterday'); // the card's engine number (A1.4.12), not the quote's own
    expect(r.body.turn.chips[0]).toMatchObject({ tool: 'quote_market', status: 'applied', args: { market_id: KC } });
    // The model got slot names, never the value.
    const price = r.body.turn.text.match(/(\d+(?:\.\d)?)%/)![1]!;
    const toolResults = chatCalls().at(-1)!.messages.filter((m: { content: string }) => m.content.startsWith('[tool result')).map((m: { content: string }) => m.content);
    expect(toolResults.join('\n')).toContain('"n1"');
    expect(toolResults.join('\n')).not.toContain(price);
  });

  it('the line written beside a tool call is kept in the reply, by code', async () => {
    const r = await chat('line beside: what does the market say on the Chiefs?');
    expect(r.body.turn.text).toMatch(/^I do math, not calls\. The market says \d+(\.\d)?%, (up [\d.]+ points?|down [\d.]+ points?|unchanged) since yesterday\.$/);
    expect(r.body.turn.chips[0]).toMatchObject({ tool: 'quote_market', status: 'applied' });
  });

  it('a reply that claims more widgets than its chips is rewritten from the chips', async () => {
    const r = await chat('count bait for the game');
    expect(r.body.turn.chips).toHaveLength(1);
    expect(r.body.turn.text).toBe('I proposed one widget: tap it to add it. Tap to add them.');
    const row = bus.entries.filter((l) => l.action === 'chat.turn').at(-1)!;
    expect(row.sizes).toMatchObject({ chips: 1, count_fixed: 1 });
  });

  it('advice bait gets the fixed line, with no chips', async () => {
    const r = await chat('advice-test');
    expect(r.body.turn.text).toBe(BLOCKED_CHAT_LINE);
    expect(r.body.turn.chips).toEqual([]);
    expect(r.body.turn.verdict_id).toMatch(/^vrd_/);
  });

  it("layer two (the guard model) blocks advice the word lists miss, and fails closed when it can't judge", async () => {
    const r = await chat('subtle advice');
    expect(r.body.turn.text).toBe(BLOCKED_CHAT_LINE);
    const g = await chat('guard garbled');
    expect(g.body.turn.text).toBe(BLOCKED_CHAT_LINE);
    const guardCalls = vultr.requests.filter((q) => q.messages[0].content.startsWith('You check text'));
    expect(guardCalls.length).toBeGreaterThan(0);
    expect(guardCalls.every((q) => !q.tools)).toBe(true);
  });

  describe('a digit the model typed itself', () => {
    const newChatCalls = async (run: () => Promise<unknown>) => {
      const before = chatCalls().length;
      await run();
      return chatCalls().slice(before);
    };

    it('a slot that was never handed out is still the blocked line', async () => {
      expect((await chat('stray slot')).body.turn.text).toBe(BLOCKED_CHAT_LINE);
    });

    it('a stray digit, then a clean retry: the retry goes out, and the first try proposes nothing', async () => {
      const pending = (await boardOf(ACC)).pending.length;
      let r!: Awaited<ReturnType<typeof chat>>;
      const calls = await newChatCalls(async () => (r = await chat('digit once for the game')));
      expect(r.body.turn.text).toBe('Tap to add it.');
      expect(r.body.turn.chips.map((c) => c.label)).toEqual(['Chiefs clean title']);
      expect(r.body.turn.chips[0]!.proposal_id).toMatch(/^.+/);
      expect((await boardOf(ACC)).pending.length).toBe(pending + 1);
      expect(calls.filter((q) => JSON.stringify(q.messages).includes(NO_DIGITS_NOTE))).toHaveLength(2);
    });

    it('a stray digit twice: the neutral line keeps the clean proposal and drops the one with the digit', async () => {
      const pending = (await boardOf(ACC)).pending.length;
      const r = await chat('digit twice for the game');
      expect(r.body.turn.text).toBe(NEUTRAL_LINE);
      expect(r.body.turn.chips.map((c) => c.label)).toEqual(['Chiefs clean title']);
      expect(JSON.stringify(r.body.turn)).not.toMatch(/73|77/);
      expect((await boardOf(ACC)).pending.length).toBe(pending + 1);
      expect(r.body.turn.picks).toBeUndefined();
    });

    it('a stray digit twice and nothing to add: the neutral line over the picks', async () => {
      const r = await chat('number bait');
      expect(r.body.turn.text).toBe(NEUTRAL_PICKS_LINE);
      expect(r.body.turn.picks?.length).toBeGreaterThan(0);
      expect(r.body.turn.text).not.toMatch(/\d/);
    });

    it('a digit in a title under a reply code wrote ("Done.") is caught too', async () => {
      const r = await chat('digit quiet for the game');
      expect(JSON.stringify(r.body.turn)).not.toContain('77');
      expect(r.body.turn.chips).toEqual([]);
    });

    it('advice beside a digit is the blocked line and gets no retry', async () => {
      let r!: Awaited<ReturnType<typeof chat>>;
      const calls = await newChatCalls(async () => (r = await chat('digit advice')));
      expect(r.body.turn.text).toBe(BLOCKED_CHAT_LINE);
      expect(r.body.turn.chips).toEqual([]);
      expect(calls).toHaveLength(1);
    });

    it('a digit in the user\'s own words is theirs to repeat, with no retry', async () => {
      let r!: Awaited<ReturnType<typeof chat>>;
      const calls = await newChatCalls(async () => (r = await chat('I follow the 49ers')));
      expect(r.body.turn.text).toBe('The 49ers it is.');
      expect(calls).toHaveLength(1);
    });

    it('the lines code writes and the retry note hold no digit', () => {
      for (const line of [NEUTRAL_LINE, NEUTRAL_PICKS_LINE, NO_DIGITS_NOTE]) expect(line).not.toMatch(/\d/);
    });
  });

  it('a blocked reply proposes nothing (advice in a widget title)', async () => {
    const pending = (await boardOf(ACC)).pending.length;
    const r = await chat('title advice');
    expect(r.body.turn.text).toBe(BLOCKED_CHAT_LINE);
    expect((await boardOf(ACC)).pending.length).toBe(pending);
  });

  it('validates every tool call: unknown tools, bad args, off-catalog widgets, unknown markets and receipts, other widgets', async () => {
    const pending = (await boardOf(ACC)).pending.length;
    const r = await chat('rogue tools');
    expect(r.body.turn.text).toBe('Those changes are not available.');
    const chips = r.body.turn.chips;
    expect(chips.map((c) => c.tool)).toEqual(['propose_widget', 'propose_widget', 'propose_widget', 'propose_widget', 'quote_market', 'read_receipt', 'remove_widget']);
    expect(chips.every((c) => c.status === 'refused' && c.proposal_id === null)).toBe(true);
    expect((await boardOf(ACC)).pending.length).toBe(pending);
    const results = chatCalls().at(-1)!.messages.filter((m: { content: string }) => m.content.startsWith('[tool result')).map((m: { content: string }) => m.content);
    expect(results[0]).toContain('no tool named place_trade');
    expect(results.join('\n')).toContain('no market kalshi:NOSUCHMARKET-1');
    expect(results.join('\n')).toContain('no such widget on this board');
  });

  it('set_look: valid values come back as a chip; the browser applies them', async () => {
    const r = await chat('Make the glass a little warmer.');
    expect(r.body.turn.chips).toEqual([{ tool: 'set_look', args: { hue: 32 }, status: 'applied', proposal_id: null, label: 'set_look · hue 32°' }]);
    expect(r.body.turn.text).toBe('Done. The glass is at hue 32 now.');
    const d = await chat('dark please');
    expect(d.body.turn.chips[0]).toMatchObject({ args: { theme: 'ice', mode: 'dark', hue: null }, status: 'applied', label: "set_look · ice · dark · theme's hue" });
  });

  it('set_look refuses bad values and never echoes them', async () => {
    const r = await chat('bad look');
    expect(r.body.turn.chips).toEqual([{ tool: 'set_look', args: {}, status: 'refused', proposal_id: null, label: 'set_look' }]);
    expect(JSON.stringify(r.body)).not.toContain('display:none');
    expect((await chat('empty look')).body.turn.chips[0]!.status).toBe('refused');
  });

  it('reads a receipt on the board through a slot', async () => {
    const r = await chat('what is receipt r-0a1b2c3d?');
    expect(r.body.turn.text).toBe('61% is the implied probability on that widget.');
    expect(r.body.turn.chips[0]).toMatchObject({ tool: 'read_receipt', status: 'applied' });
  });

  it("tune_widget takes the user's own probability, never one the model made up", async () => {
    const ok = await chat(`my probability is 70% for ${probWidget}`);
    expect(ok.body.turn.chips[0]).toMatchObject({ tool: 'tune_widget', status: 'proposed', args: { widget_id: probWidget, user_probability: 0.7 } });
    const bad = await chat(`tune made up ${probWidget}`);
    expect(bad.body.turn.chips[0]).toMatchObject({ tool: 'tune_widget', status: 'refused' });
  });

  it("the made-up probability never reads as the user's number in a widget id (the random-id flake)", () => {
    // Ids like the board's random ones, with every one- and two-digit run in them. The old 0.9 matched "wid_ab90cd".
    const ids = Array.from({ length: 100 }, (_, n) => `wid_ab${n}cd${n % 10}ef`);
    for (const id of ids) expect(isUsersNumber(MADE_UP_PROBABILITY, [`tune made up ${id}`]), id).toBe(false);
    expect(isUsersNumber(0.9, ['tune made up wid_ab90cd'])).toBe(true);
  });

  it('a Tune chat changes only its own widget', async () => {
    const other = board.widgets.find((w) => w.spec.kind === 'display' && w.spec.widget_id !== probWidget)!.spec.widget_id;
    const own = await chat(`remove it ${probWidget}`, null, probWidget);
    expect(own.body.turn.chips[0]).toMatchObject({ tool: 'remove_widget', status: 'proposed' });
    const r = await chat(`remove it ${other}`, own.body.conversation_id);
    expect(r.body.turn.chips[0]).toMatchObject({ tool: 'remove_widget', status: 'refused' });
    expect((await chat('hi', own.body.conversation_id, other)).status).toBe(400);
  });

  it('stops a tool loop after MAX_STEPS model calls', async () => {
    const n = chatCalls().length;
    const r = await chat('loop forever');
    expect(chatCalls().length - n).toBe(MAX_STEPS);
    expect(r.body.turn.text).toBe('Done.');
  });

  it('a repeated tool call runs once', async () => {
    const pending = (await boardOf(ACC)).pending.length;
    const r = await chat('repeat yourself');
    expect(r.body.turn.chips.map((c) => c.status)).toEqual(['proposed']);
    expect((await boardOf(ACC)).pending.length).toBe(pending + 1);
  });

  it('the model never reads page text, summaries, facts or a value', () => {
    const sent = sentToModel();
    for (const s of ['listed as questionable', 'A starting tackle', 'Implied probability {n1}', 'sportswire.fixture.test', '0.61']) expect(sent).not.toContain(s);
    expect(sent).toContain('r-0a1b2c3d (implied_probability)');
  });

  it('history: the model reads its own templates back, never a filled value', async () => {
    const first = await chat('should I buy YES on the Chiefs?');
    const price = first.body.turn.text.match(/(\d+(?:\.\d)?)%/)![1]!;
    await chat('hi', first.body.conversation_id);
    const last = chatCalls().at(-1)!.messages as { role: string; content: string }[];
    const assistant = last.filter((m) => m.role === 'assistant').map((m) => m.content).join('\n');
    expect(assistant).toContain('(a number from a tool)');
    expect(assistant).not.toContain(`${price}%`);
    const conv = await agentApp.request(`/conversations/${first.body.conversation_id}?account_id=${ACC}`, { headers: { authorization: `Bearer ${TEST_TOKENS.edge}` } });
    const turns = ((await conv.json()) as { turns: { role: string; text: string }[] }).turns;
    expect(turns.map((t) => t.role)).toEqual(['user', 'agent', 'user', 'agent']);
    expect(turns[1]!.text).toContain(`${price}%`);
  });

  it("another account can't read or continue a conversation", async () => {
    const r = await chat('hi');
    expect((await chat('hi', r.body.conversation_id, null, 'acc_someoneelse01')).status).toBe(400);
    const g = await agentApp.request(`/conversations/${r.body.conversation_id}?account_id=acc_someoneelse01`, { headers: { authorization: `Bearer ${TEST_TOKENS.edge}` } });
    expect(g.status).toBe(404);
  });

  it('logs every turn to the audit stream with ids, hashes and sizes only', () => {
    const turns = bus.entries.filter((e) => e.service === 'agent' && e.action === 'chat.turn');
    expect(turns.length).toBeGreaterThan(10);
    expect(turns.some((e) => e.outcome === 'blocked')).toBe(true);
    expect(JSON.stringify(turns)).not.toContain('advice-test');
    expect(JSON.stringify(turns)).not.toContain(BLOCKED_CHAT_LINE);
  });
});
