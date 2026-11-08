/**
 * W1.2.2 (contract): News and Your account in words. News items are plain lines with outlet and time; a summary's slots
 * are filled by code from the engine's numbers (a digit the model typed is never shown); a blocked page is the plain line
 * and its time only; before the first research run the card says what comes and about when (runner's cadence window).
 * Your account's money moves are an arrow and words.
 */
import { describe, expect, it, vi } from 'vitest';
import { POISONED_NOTE, newId, type Widget, type WidgetResult } from '@app/contracts';
import { sampleResult } from '@app/testkit';

vi.stubGlobal('document', { documentElement: {} });
const W = await import('../../src/widgets.ts');

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const spec = (widget_id: string, size: 'M' | 'L') =>
  ({ kind: 'display', type: 'news', size, title: 'Team news', market_ids: ['kalshi:KXNFLGAME-26NOV08KCBUF-BUF'], params: { team: 'Bills' }, widget_id, account_id: 'acc_x', place: { col: 0, row: 0 } }) as const;
const widget = (r: WidgetResult | null, profile: Widget['profile'] = null, size: 'M' | 'L' = 'M'): Widget => {
  const s = spec(r?.widget_id ?? newId('wid'), size);
  return { spec: s as unknown as Widget['spec'], profile, state: 'normal', result: r, previous: null, updated_at: new Date().toISOString() };
};
const ctx = { titles: new Map<string, string>(), events: new Map<string, string>() };
const H = 3600_000;

/** A research result with two clean articles and one blocked page. */
function research(now: number) {
  const r = sampleResult(newId('wid'), 'acc_x', 'pass').result;
  const a = r.sources[0]!;
  a.published_at = new Date(now - 2 * H).toISOString();
  const b = newId('cnd');
  const bad = newId('cnd');
  r.sources.push(
    { candidate_id: b, url: 'https://weatherdesk.fixture.test/nfl/orchard-park-winds.html', domain: 'weatherdesk.fixture.test', outlet: 'Weather Desk', published_at: new Date(now - 30 * 60_000).toISOString(), status: 'read' },
    { candidate_id: bad, url: 'https://fanpost.fixture.test/nfl/chiefs-bills-insider.html', domain: 'fanpost.fixture.test', outlet: 'Fan Post', published_at: null, status: 'blocked' },
  );
  r.facts.push(
    { fact_id: 'f2', candidate_id: b, claim: 'Winds of 25 mph are expected at kickoff.', quote: 'gusts near 25 mph at kickoff' },
    // The same news again from a second outlet is one item.
    { fact_id: 'f3', candidate_id: b, claim: 'A starting tackle is questionable.', quote: 'questionable' },
  );
  r.blocked = [{ candidate_id: bad, domain: 'fanpost.fixture.test', reason: 'poison', note: POISONED_NOTE, killed_at: new Date(now - 60_000).toISOString(), audit_row_id: null }];
  return r;
}

describe('News', () => {
  it('agoWords: "2 h", "35 min", "3 days", "just now"', () => {
    const now = Date.parse('2026-11-08T15:00:00Z');
    expect(W.agoWords(new Date(now - 2 * H).toISOString(), now)).toBe('2 h');
    expect(W.agoWords(new Date(now - 35 * 60_000).toISOString(), now)).toBe('35 min');
    expect(W.agoWords(new Date(now - 3 * 24 * H).toISOString(), now)).toBe('3 days');
    expect(W.agoWords(new Date(now - 10_000).toISOString(), now)).toBe('just now');
    expect(W.agoWords(null, now)).toBe('');
  });

  it("fills the summary's slots from the engine's numbers and the fact's quote", () => {
    const r = sampleResult(newId('wid'), 'acc_x', 'pass').result;
    expect(W.summaryWords(r)).toBe('Implied probability 61%; the exchanges differ by 2 points. “listed as questionable”');
  });

  it('shows no summary when a slot has no engine number, or the template has a digit outside a slot', () => {
    const r = sampleResult(newId('wid'), 'acc_x', 'pass').result;
    expect(W.summaryWords({ ...r, numbers: r.numbers.slice(0, 1) })).toBeNull();
    expect(W.summaryWords({ ...r, summary: { ...r.summary!, template: 'About 3 in 5: {n1}' } })).toBeNull();
    // A slot pointing at a number with another receipt is not that number.
    const s = structuredClone(r.summary!);
    (s.slots.n1 as { receipt_id: string }).receipt_id = 'r-ffffffff';
    expect(W.summaryWords({ ...r, summary: s })).toBeNull();
    expect(W.summaryWords({ ...r, summary: null })).toBeNull();
  });

  it("a line with a digit the reader typed is the article's own quote instead", () => {
    expect(W.factLine({ claim: 'Winds of 25 mph are expected at kickoff.', quote: 'gusts near 25 mph at kickoff' })).toBe('gusts near 25 mph at kickoff');
    expect(W.factLine({ claim: 'A starting tackle is questionable.', quote: 'listed as questionable' })).toBe('A starting tackle is questionable.');
  });

  it('2–3 items with outlet and time, one per distinct line; the blocked page is the plain line and its time only', () => {
    const now = Date.now();
    const r = research(now);
    const h = W.displayHtml(widget(r, null, 'L'), ctx);
    const t = text(h);
    expect(t).toContain('A starting tackle is questionable. Sports Wire · 2 h');
    expect(t).toContain('gusts near 25 mph at kickoff Weather Desk · 30 min');
    expect(t.match(/A starting tackle is questionable\./g)).toHaveLength(1);
    expect(t).toContain('Blocked: this page tried to trick the agent. Its sealed box was destroyed.');
    expect((h.match(/class="item item--(tap|blocked)"/g) ?? []).length).toBe(3);
    // Each clean item opens How we got this at its article; the blocked one has no article to open and no picture.
    const tap = [...h.matchAll(/data-cnd="([^"]+)"/g)].map((m) => m[1]);
    expect(tap).toEqual([r.sources[0]!.candidate_id, r.sources[1]!.candidate_id]);
    expect(h).not.toContain(r.blocked[0]!.candidate_id);
    expect(t).not.toContain('Fan Post');
    expect(t).not.toContain(POISONED_NOTE);
    expect(h).not.toMatch(/<img/);
    // At most 3 items, the blocked one among them.
    const many = research(now);
    for (let i = 0; i < 4; i++) many.facts.push({ fact_id: `f${9 + i}`, candidate_id: many.sources[0]!.candidate_id, claim: `Another note number ${'abcd'[i]}.`, quote: 'questionable' });
    const hm = W.displayHtml(widget(many, null, 'L'), ctx);
    expect((hm.match(/class="item item--(tap|blocked)"/g) ?? []).length).toBe(3);
    expect(hm).toContain('item--blocked');
    // A medium tile: one article beside the blocked page; with no blocked page, three articles.
    const med = W.displayHtml(widget(many), ctx);
    expect((med.match(/class="item item--tap"/g) ?? []).length).toBe(1);
    expect((med.match(/class="item item--blocked"/g) ?? []).length).toBe(1);
    many.blocked = [];
    expect((W.displayHtml(widget(many), ctx).match(/class="item item--tap"/g) ?? []).length).toBe(3);
  });

  it('a fact from a blocked page never shows, even if one came through', () => {
    const r = research(Date.now());
    r.facts.push({ fact_id: 'f8', candidate_id: r.blocked[0]!.candidate_id, claim: 'Words from the page that tried a trick.', quote: 'x' });
    expect(text(W.displayHtml(widget(r), ctx))).not.toContain('Words from the page');
  });

  it("before the first research run: what comes and about when (runner's next cadence window, or Refresh now)", () => {
    const now = Date.parse('2026-11-08T14:20:00Z');
    const t = W.firstNewsWords(widget(null), now);
    expect(t).toBe(`The first news comes at about ${W.fmtTime('2026-11-08T15:00:00.000Z')}. To get it sooner, tap ⋯ then Refresh now.`);
    expect(W.firstNewsWords(widget(null), Date.parse('2026-11-08T14:59:00Z'))).toBe('The first news comes in a minute or two. To get it sooner, tap ⋯ then Refresh now.');
    const off = { widget_id: 'w', brief: '', source_ids: [], added_domains: [], cadence: { numbers_every_s: null, research_every_s: null }, feedback: [], last_math_plan: null };
    expect(W.firstNewsWords(widget(null, off), now)).toBe('The news comes when you tap ⋯ then Refresh now.');
    const card = text(W.displayHtml(widget(null), ctx));
    expect(card).toContain('We read the latest articles about the Bills from Sports Wire, Weather Desk and Fan Post, each in its own sealed box, destroyed after.');
  });
});
