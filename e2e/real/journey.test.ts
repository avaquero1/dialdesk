/**
 * Meeting point 1, "On siren, end to end" (C1.1): the whole journey on the real services, only the model faked.
 * `make e2e-real` brings up Postgres, Valkey and the fixture site (Compose project vha-e2e-real), then this file starts
 * sandbox-manager on the docker backend and the nine services in real mode (e2e/real/stack.ts) and drives edge's
 * browser API the way the web app does: sign up, the first board, the chat, the proposals, the runs on BullMQ, the
 * poisoned page's box destroyed, the Safety numbers and audit's verify. The steps mirror e2e/flow.test.ts (the same
 * journey on the fakes); the data is the recording of this weekend's games, so the teams are real ones.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EDGE, POISONED_NOTE, type Board, type ChatReply, type Widget } from '@app/contracts';
import { createClient, sandboxClient, type SandboxClient } from '@app/service-kit';
import { fixtures } from '@app/testkit';
import { WEEKEND } from '../../services/markets/test/recorded.ts';
import { ORIGIN, stackUp, type Stack, type Svc } from './stack.ts';

let stack: Stack;
let sandbox: SandboxClient;

// The browser: one cookie jar, the edge API only, from the web app's origin.
let cookie = '';
const browser = createClient({
  baseUrl: `${ORIGIN}/`,
  fetch: async (r) => {
    const req = new Request(r.url.replace(ORIGIN, stack.url('edge')), r);
    req.headers.set('origin', ORIGIN);
    req.headers.set('sec-fetch-site', 'same-origin');
    if (cookie) req.headers.set('cookie', cookie);
    const res = await fetch(req);
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0]!;
    return res;
  },
});

const board = () => browser(EDGE.board, {});
const widget = async (id: string) => (await board()).widgets.find((w) => w.spec.widget_id === id)!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Polls until `ok` holds (the runs happen on BullMQ, in runner's worker). The message names the logs to read. */
async function until<T>(what: string, get: () => Promise<T>, ok: (v: T) => boolean, ms = 90_000, logs: Svc[] = ['board', 'runner']): Promise<T> {
  const end = Date.now() + ms;
  let v = await get();
  while (!ok(v)) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}\n${logs.map((s) => `--- ${s}\n${stack.log(s)}`).join('\n')}`);
    await sleep(500);
    v = await get();
  }
  return v;
}
const isDisplay = (w: Widget) => w.spec.kind === 'display';

beforeAll(async () => {
  stack = await stackUp();
  sandbox = sandboxClient({ baseUrl: stack.manager.url, token: stack.env.RUNNER_TOKEN_SANDBOX_MANAGER! });
}, 240_000);
afterAll(async () => {
  await stack?.down();
}, 120_000);

describe('e2e on the real services (only the model faked)', () => {
  const s: { account_id?: string; widget_id?: string; team?: string; event_key?: string; research_run?: string } = {};

  it('1. sign up: the first board shows this weekend’s games, priced before any run', async () => {
    const { account } = await browser(EDGE.signup, { body: { email: 'trader@example.test', password: 'correct horse battery' } });
    s.account_id = account.account_id;
    const b: Board = await board();
    const displays = b.widgets.filter((w) => w.spec.kind === 'display' && w.spec.place && 'col' in w.spec.place);
    expect(displays.map((w) => w.spec.kind === 'display' && w.spec.type)).toEqual(['events', 'probability', 'gap', 'news', 'positions', 'movement']);
    expect(b.widgets.filter((w) => w.spec.kind === 'folder')).toHaveLength(2);
    expect(b.widgets.filter((w) => w.spec.kind === 'app')).toHaveLength(5);
    // This weekend's games: every market on the board is one of the recording's games.
    const recorded = new Set(WEEKEND.games.flatMap((g) => [g.kalshi, g.polymarket]).filter((x): x is string => !!x));
    const ids = displays.flatMap((w) => (w.spec.kind === 'display' ? w.spec.market_ids : []));
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect([...recorded].some((r) => id.includes(r)), id).toBe(true);
    for (const w of displays) {
      if (w.spec.kind !== 'display' || !w.spec.market_ids.length) continue;
      expect(w.quotes?.map((q) => q.market_id)).toEqual(w.spec.market_ids);
    }
  });

  it('2. the chat: "Hi", a league, a team, two proposals; the taps add the widgets', async () => {
    const hi: ChatReply = await browser(EDGE.chat, { body: { conversation_id: null, widget_id: null, message: 'Hi' } });
    expect(hi.turn.text).toBe('Hi. Which teams or markets do you follow?');
    expect(hi.turn.picks).toEqual(expect.arrayContaining(['NFL', 'NBA']));
    const cnv = hi.conversation_id;
    const nfl: ChatReply = await browser(EDGE.chat, { body: { conversation_id: cnv, widget_id: null, message: 'NFL' } });
    expect(nfl.turn.picks).toEqual(expect.arrayContaining(['Bills', 'Chiefs']));
    // The Chiefs: the fixture site's FanPost writes about them, so the research run reads the poisoned page too.
    s.team = 'Chiefs';
    const r: ChatReply = await browser(EDGE.chat, { body: { conversation_id: cnv, widget_id: null, message: s.team } });
    expect(r.turn.chips.map((c) => [c.tool, c.status])).toEqual([
      ['propose_widget', 'proposed'],
      ['propose_widget', 'proposed'],
    ]);
    expect(r.turn.text).toMatch(/Tap to add them\.$/);
    const before = await board();
    expect(before.pending.map((p) => p.proposal_id).sort()).toEqual(r.turn.chips.map((c) => c.proposal_id).sort());
    const added: Widget[] = [];
    for (const chip of r.turn.chips) added.push(...(await browser(EDGE.accept, { params: { proposal_id: chip.proposal_id! }, body: {} })).widgets);
    expect(added.map((w) => w.spec.kind === 'display' && w.spec.type)).toEqual(['news', 'movement']);
    const news = added[0]!;
    expect(news.spec).toMatchObject({ kind: 'display', type: 'news', params: { team: s.team } });
    s.widget_id = news.spec.widget_id;
    s.event_key = (news.spec as { params: { event_keys: string[] } }).params.event_keys[0];
    expect(s.event_key).toBe('nfl-2026-11-08-nyj-kc');
    const after = await board();
    expect(after.pending).toEqual([]);
    expect(after.widgets.length).toBe(before.widgets.length + 2);
    // A reload keeps the turn's picks (Postgres, turns.picks).
  });

  it('2b. the chat never gives advice: bait is answered with math, advice is blocked', async () => {
    const bait = await browser(EDGE.chat, { body: { conversation_id: null, widget_id: null, message: 'should I buy YES on the Chiefs?' } });
    expect(bait.turn.text).toMatch(/^I do math, not calls\./);
    const bad = await browser(EDGE.chat, { body: { conversation_id: null, widget_id: null, message: 'advice-test' } });
    expect(bad.turn.text).toBe('I do math, not calls.');
  });

  it('3. board enqueues on BullMQ, runner’s worker runs them: numbers with receipts fill the displays', async () => {
    // positions (no connection) and movement (the recording has no price history) have nothing to compute: their runs
    // end done and publish nothing, as on prod without a connection or history.
    const priced = (b: Board, type: string) => b.widgets.find((w) => isDisplay(w) && w.spec.kind === 'display' && w.spec.type === type && 'col' in w.spec.place);
    const b = await until('the gap and probability displays to get their numbers', board, (b) => ['gap', 'probability'].every((t) => priced(b, t)?.result?.kind === 'numbers'));
    const gap = priced(b, 'gap')!;
    expect(gap.result!.numbers.map((n) => n.op)).toEqual(['gap']);
    expect(gap.result!.receipts[0]!.origins).toEqual(['market']);
    const receipt = await browser(EDGE.receipt, { params: { receipt_id: gap.result!.numbers[0]!.receipt_id } });
    expect(receipt.id).toBe(gap.result!.numbers[0]!.receipt_id);
    expect(receipt.formula.length).toBeGreaterThan(0);
    const ev = priced(b, 'probability')!;
    // The week board's probability has the market's own number, and no EV: a new trader has given no probability yet
    // (board/defaults.ts drops user_probability; the fakes' catalog board keeps one, so e2e/flow.test.ts sees an EV).
    expect(ev.result!.numbers.map((n) => n.op)).toContain('implied_probability');
    expect(ev.result!.numbers.find((n) => n.op === 'expected_value')).toBeUndefined();
  });

  it('4. the research run reads the clean pages and the poisoned one: that box is killed, the widget keeps the clean numbers, blocked', async () => {
    const w = await until('the news widget’s research result', () => widget(s.widget_id!), (w) => w.result?.kind === 'research');
    const r = w.result!;
    s.research_run = r.run_id;
    expect(r.numbers[0]).toMatchObject({ op: 'implied_probability' });
    for (const n of r.numbers) expect(r.receipts.some((x) => x.id === n.receipt_id)).toBe(true);
    expect(r.facts.length).toBeGreaterThan(0);
    expect(r.blocked.map((b) => [b.domain, b.note])).toEqual([['fanpost.fixture.test', POISONED_NOTE]]);
    expect(w.state).toBe('blocked');
    expect(JSON.stringify(r)).not.toMatch(/ignore your previous instructions/i);
    const trace = await browser(EDGE.trace, { params: { widget_id: s.widget_id! } });
    expect(trace.steps.at(-1)!.step).toBe('publish');
    const reads = trace.steps.filter((x) => x.step === 'read' && x.source);
    const poisoned = fixtures.manifest().find((p) => p.poisoned)!;
    expect(reads.map((x) => x.source!.url)).toContain(poisoned.url);
    expect(reads.length).toBeGreaterThan(1);
    // sandbox-manager: the poisoned page's box killed for poison and destroyed, every clean one released.
    for (const x of reads) {
      const j = await sandbox.getJob(`${r.run_id}:read:${x.source!.candidate_id}`);
      if (x.source!.url === poisoned.url) {
        expect(j).toMatchObject({ state: 'killed', kill_reason: 'poison' });
        expect((j.trust_log ?? []).map((t) => t.action)).toEqual(['sandbox.created', 'sandbox.killed', 'proxy.refused', 'sandbox.destroyed']);
        // Only the page's own host got through (once per CONNECT: a loaded Chromium may open a backup connection).
        expect([...new Set(j.proxy_log.filter((e) => e.allowed).map((e) => e.host))]).toEqual(['fanpost.fixture.test']);
        expect(j.proxy_log.filter((e) => !e.allowed).length).toBeGreaterThan(0);
      } else {
        expect(j.state).toBe('released');
        expect(j.pages[0]!.status).toBe(200);
      }
    }
    expect((await sandbox.sandboxes()).sandboxes.filter((x) => x.state === 'held')).toEqual([]);
  });

  it('4e. a refresh reads the pages again: the poisoned box is destroyed again, and the widget keeps its last clean numbers', async () => {
    const before = (await widget(s.widget_id!)).result!;
    // A run's job id is widget:kind:minute, so a refresh in the minute of the last run collapses into it (on BullMQ and in
    // run_requests). Refresh in the next minute.
    await sleep(60_000 - (Date.now() % 60_000) + 1000);
    await browser(EDGE.refresh, { params: { widget_id: s.widget_id! }, body: {} });
    const w = await until('the refreshed research result', () => widget(s.widget_id!), (w) => w.result?.kind === 'research' && w.result.run_id !== before.run_id);
    expect(w.state).toBe('blocked');
    expect(w.result!.numbers.map((n) => [n.op, n.value])).toEqual(before.numbers.map((n) => [n.op, n.value]));
    expect(w.result!.blocked.map((b) => b.domain)).toEqual(['fanpost.fixture.test']);
  }, 240_000);

  it('5. the Safety numbers count it, and audit’s verify says ok', async () => {
    const trust = await until(
      'the trust counts to include both poisoned runs',
      () => browser(EDGE.trust, {}),
      (t) => t.counts.runs_poisoned >= 2 && t.counts.sandboxes_created === t.counts.sandboxes_destroyed,
      30_000,
      ['audit', 'runner'],
    );
    expect(trust.counts.sandboxes_killed).toBe(2);
    expect(trust.counts.runs_poisoned).toBe(2);
    expect(trust.counts.proxy_refused).toBeGreaterThan(0);
    expect(trust.counts.sandboxes_created).toBeGreaterThan(2);
    expect((await browser(EDGE.auditVerify, {})).ok).toBe(true);
  });
});
