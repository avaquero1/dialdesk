/**
 * W1.2.1 (contract): the displays read what the numbers steps make. The first board's displays get a real numbers run
 * (runner's plans on markets' fake, batched, through the real engine: display-results.ts), and each display shows its
 * numbers in plain words (design.md section 3) from the receipts as the engine writes them.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { MARKETS, newId, type Widget, type WidgetResult } from '@app/contracts';
import { createClient } from '@app/service-kit';
import { TEST_TOKENS, fakeApp } from '@app/testkit';
import { prescribedTiles } from '../../../services/board/src/defaults.ts';
import { fake as markets } from '../../../services/markets/src/fake.ts';
import { numbersRun, type Made } from '../display-results.ts';

vi.stubGlobal('document', { documentElement: {} });
const W = await import('../../src/widgets.ts');

const call = createClient({ baseUrl: 'http://svc.internal', token: TEST_TOKENS.board, fetch: (r) => fakeApp('markets', MARKETS, markets()).fetch(r) });
type Spec = Made['spec'];
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const widget = (spec: Spec, result: WidgetResult | null): Widget => ({ spec, profile: null, state: 'normal', result, previous: null, updated_at: new Date().toISOString() });

let made: Made[];
const ctx = { titles: new Map<string, string>(), events: new Map<string, string>() };
const byType = (t: Spec['type'], pick: (s: Spec) => boolean = () => true) => made.find((m) => m.spec.type === t && pick(m.spec))!;
const html = (m: Made, r: WidgetResult | null = m.body.result) => W.displayHtml(widget(m.spec, r), ctx);
const rec = (r: WidgetResult, id: string) => r.receipts.find((x) => x.id === id)!;

beforeAll(async () => {
  const account_id = newId('acc');
  const tiles = await prescribedTiles(call, Date.now());
  const specs: Spec[] = tiles.flatMap((t) =>
    t.kind === 'display' ? [{ kind: 'display' as const, type: t.type, size: t.size, market_ids: t.market_ids, params: t.params, widget_id: newId('wid'), account_id, title: t.title, place: { col: 0, row: 0 } }] : [],
  );
  for (const s of specs) {
    const keys = s.params.event_keys ?? [];
    if (keys.length === 1 && s.type === 'probability') ctx.titles.set(keys[0]!, s.title);
    s.market_ids.forEach((m, i) => {
      const k = keys.length === 1 ? keys[0] : keys[i];
      if (k) ctx.events.set(m, k);
    });
  }
  made = await numbersRun(specs.filter((s) => s.type !== 'news' && s.type !== 'positions'), account_id);
}, 240_000);

describe('W1.2.1: the displays show what the numbers steps made, in plain words', () => {
  it('the batch receipts carry their b<i>_ prefix (what How we got this hides)', () => {
    const r = byType('probability').body.result;
    expect(r.receipts.length).toBeGreaterThan(0);
    for (const x of r.receipts) expect(x.op_id).toMatch(/^b\d+_n\d+$/);
  });

  it('A1.4.12: first paint shows the price and no move: the exchange\'s own figure may reverse a minute later', () => {
    const as_of = new Date().toISOString();
    const quote = (market_id: string) => ({ market_id, exchange: 'kalshi' as const, yes_price_cents: 68, previous_price_cents: 62, as_of, stale: false });
    for (const m of [byType('probability'), byType('events'), byType('movement', (s) => s.market_ids.length === 1) ?? byType('movement')]) {
      const w = { ...widget(m.spec, null), quotes: m.spec.market_ids.map(quote) };
      const t = text(W.displayHtml(w, ctx));
      expect(t, m.spec.type).toContain('68%');
      expect(t, m.spec.type).not.toMatch(/\bup \d|\bdown \d|since yesterday|▲|▼/i);
      expect(W.cardNumbers(w)).toMatchObject({ p: 68, d: null, line: [] });
    }
  });

  it('A market: the chance, "since yesterday" from the 24 h movement, the 7-day line from price_at, the prices and base rates from the receipts', () => {
    const m = byType('probability', (s) => s.title.includes(' beat the '));
    const r = m.body.result;
    const h = html(m);
    const t = text(h);
    const ip = r.numbers.find((n) => n.op === 'implied_probability')!;
    expect(t).toContain(`${Math.round(ip.value * 100)}% chance`);
    // The move whose window is 24 h.
    const day = r.numbers.find((n) => n.op === 'movement' && rec(r, n.receipt_id).args.window_s === 86400)!;
    expect(day).toBeTruthy();
    expect(t).toContain(W.moveWords(Math.round(day.value), 'since yesterday'));
    // The line: price_at points oldest first (largest ago_s first).
    const pts = r.numbers.filter((n) => n.op === 'price_at').map((n) => ({ v: n.value, ago: rec(r, n.receipt_id).args.ago_s as number }));
    expect(pts).toHaveLength(8);
    expect(h).toContain(W.spark(pts.sort((a, b) => b.ago - a.ago).map((p) => p.v)));
    expect(t).toContain('7 days');
    // The prices the engine read (its receipt's price_cents, with the market it came from).
    const k = r.receipts.find((x) => x.op === 'implied_probability' && x.provenance?.price_cents?.source.startsWith('kalshi:'))!;
    expect(t).toContain(`Kalshi ${k.args.price_cents}¢`);
    expect(t).toContain('for a YES that pays $1');
    // Base rates with n and source, or the note that says why not.
    const br = r.numbers.filter((n) => n.op === 'base_rate_history');
    for (const n of br) {
      const x = rec(r, n.receipt_id);
      expect(t).toContain(`won ${Math.round(n.value * 100)}% of ${x.sample_size} NFL games on Kalshi this season.`);
    }
    expect(t).toMatch(/Home teams won \d+% of \d+ NFL games on Kalshi this season\./);
    for (const note of r.notes ?? []) expect(t).toContain(note);
  });

  it('Tonight: each game\'s chance and its move with an arrow and words', () => {
    const m = byType('events');
    const r = m.body.result;
    const t = text(html(m));
    for (const n of r.numbers.filter((x) => x.op === 'implied_probability')) expect(t).toContain(`${Math.round(n.value * 100)}%`);
    for (const n of r.numbers.filter((x) => x.op === 'movement')) {
      const d = Math.round(n.value);
      expect(t).toContain(d > 0 ? `▲ up ${d}` : d < 0 ? `▼ down ${-d}` : '— no change');
    }
  });

  it('Two prices: "N points apart" from the gap, never negative, with the prices the engine read', () => {
    const m = byType('gap');
    const r = m.body.result;
    const t = text(html(m));
    expect(t).toMatch(/^Two prices/);
    const g = r.numbers.find((n) => n.op === 'gap');
    if (!g) return void expect(t).toMatch(/Not compared/);
    const x = rec(r, g.receipt_id);
    expect(t).toContain(`Kalshi ${x.args.a_cents}¢`);
    expect(t).toContain(`Polymarket ${x.args.b_cents}¢`);
    const n = Math.abs(Math.round(g.value));
    expect(t).toContain(n === 0 ? 'The same price on both' : `${n} ${n === 1 ? 'point' : 'points'} apart`);
    // A negative gap (Polymarket below Kalshi) still reads as a distance.
    const neg: WidgetResult = { ...r, numbers: r.numbers.map((y) => (y.op === 'gap' ? { ...y, value: -3 } : y)) };
    expect(text(html(m, neg))).toContain('3 points apart');
  });

  it('Two prices: a game that isn\'t paired shows runner\'s sentence and no gap', () => {
    const m = byType('gap');
    const why = 'Not compared: Polymarket names the teams in another order, so its YES may mean the other team wins.';
    const r: WidgetResult = { ...m.body.result, numbers: [], receipts: [], summary: { template: why, slots: {} } };
    const t = text(html(m, r));
    expect(t).toContain(why);
    expect(t).not.toMatch(/apart/);
  });

  it('Biggest move: its game from the receipt\'s provenance, the move in words, the line from price_at', () => {
    const m = byType('movement');
    const r = m.body.result;
    const mv = r.numbers.find((n) => n.op === 'movement')!;
    const src = rec(r, mv.receipt_id).provenance!.series!.source;
    const h = html(m);
    const t = text(h);
    expect(t).toMatch(/^Biggest move/);
    expect(t).toContain(W.marketLabel(src, ctx));
    expect(W.marketLabel(src, ctx)).not.toBe('');
    expect(t).toMatch(/(Up|Down) \d+ points? (since yesterday|in \d+ \w+)|No change/);
    expect(h).toContain('<polyline');
  });

  it('no inside words on any display: no "pts", no "implied", no "Gap" or "Positions" as a title', () => {
    for (const m of made) {
      const t = text(html(m));
      expect(t).not.toMatch(/\bpts?\b/);
      expect(t).not.toMatch(/implied/i);
      expect(t).not.toMatch(/^(Gap|Positions|Movement)\b/);
    }
  });

  it('a down move is the same neutral color as an up move (arrow and words, never red)', () => {
    expect(text(W.displayHtml(widget(byType('movement').spec, null), ctx))).not.toMatch(/pts/);
    expect(W.moveWords(-3, 'since yesterday')).toBe('Down 3 points since yesterday');
    expect(W.moveWords(1)).toBe('Up 1 point');
    expect(W.moveWords(0, 'since yesterday')).toBe('No change since yesterday');
  });

  it('"Updated just now" after a refresh joined a run of this minute', () => {
    const m = byType('events');
    const w = widget(m.spec, m.body.result);
    W.justNow.set(m.spec.widget_id, Date.now());
    expect(W.stampWords(w)).toMatch(/^Updated just now/);
    W.justNow.set(m.spec.widget_id, Date.now() - 120_000);
    expect(W.stampWords(w)).not.toMatch(/just now/);
  });
});
