/**
 * Renders a widget from its spec and data: a result when one exists, else the first-paint quotes board copied from
 * markets (exchange prices with their "as of" time). Every value is escaped; nothing here renders HTML from the
 * server or from a model. The words follow design.md section 3: "62% chance", "Up 4 points since yesterday", "2
 * points apart"; a move has an arrow and words, never a good or bad color.
 */
import { SOURCE_CATALOG, displayEntry, type Quote, type Widget, type WidgetResult } from '@app/contracts';
import { connections, exchangeName } from './conns.ts';
import { css, esc } from './dom.ts';
import { IC } from './icons.ts';

type Num = WidgetResult['numbers'][number];
type Receipt = WidgetResult['receipts'][number];
type Display = Extract<Widget['spec'], { kind: 'display' }>;

/** The apps' names on screen (design section 6); the inside names (trust, receipts, catalog) stay in code. */
export const APP_NAMES: Record<string, string> = { trust: 'Safety', receipts: 'How we got it', accounts: 'Accounts', catalog: 'Add', settings: 'Settings' };
/** The catalog's inside titles of the displays, and their names on screen. A title the user or the agent chose stays. */
export const DISPLAY_NAMES: Record<string, string> = { Gap: 'Two prices', Positions: 'Your account', Movement: 'Biggest move' };
/** A tile's name on screen: an app's plain name, else its title in plain words. */
export const tileName = (w: Widget) => (w.spec.kind === 'app' ? (APP_NAMES[w.spec.app] ?? w.spec.title) : w.spec.kind === 'display' ? (DISPLAY_NAMES[w.spec.title] ?? w.spec.title) : w.spec.title);

// ---------- small formatters ----------

export const fmtTime = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
};
const DAY_S = 86400;
const mvCls = (d: number) => (d > 0 ? 'up' : d < 0 ? 'down' : 'flat');
const ARROW = { up: '▲', down: '▼', flat: '—' } as const;
const points = (n: number) => `${n} ${n === 1 ? 'point' : 'points'}`;
/** A move's time window in words: "since yesterday" for 24 h. */
export function sinceWords(window_s: number | undefined): string {
  if (window_s == null) return '';
  if (window_s === DAY_S) return 'since yesterday';
  if (window_s % DAY_S === 0) return window_s === 7 * DAY_S ? 'this week' : `in ${window_s / DAY_S} days`;
  if (window_s % 3600 === 0) return `in ${window_s / 3600} ${window_s === 3600 ? 'hour' : 'hours'}`;
  return `in ${Math.round(window_s / 60)} minutes`;
}
/** "Up 4 points since yesterday", "Down 1 point", "No change since yesterday". */
export function moveWords(d: number, since = ''): string {
  const t = d > 0 ? `Up ${points(d)}` : d < 0 ? `Down ${points(-d)}` : 'No change';
  return since ? `${t} ${since}` : t;
}
/** A move with its arrow and words. Short: "▲ up 4" (a row of games); long: "▲ Up 4 points since yesterday". */
function mvEl(d: number, o: { long?: boolean; since?: string } = {}) {
  const c = mvCls(d);
  const words = o.long ? moveWords(d, o.since) : d === 0 ? 'no change' : `${c} ${Math.abs(d)}`;
  return `<span class="mv mv--${c} num"><span class="mv-a" aria-hidden="true">${ARROW[c]}</span> ${esc(words)}</span>`;
}
/** What a screen reader says for a number's line (design.md section 12), on an element whose text is replaced by it. */
const says = (words: string) => ` role="img" aria-label="${esc(words)}"`;
/** A line's numbers in words: "61%" as "61 percent", "61¢" as "61 cents", a sign as a word. */
export const spoken = (t: string) =>
  t
    .replace(/(^|[\s(])\+(?=[\d$])/g, '$1plus ')
    .replace(/−/g, 'minus ')
    .replace(/(\d+(?:\.\d+)?)%/g, '$1 percent')
    .replace(/(\d+(?:\.\d+)?)¢/g, (_m, n: string) => (n === '1' ? '1 cent' : `${n} cents`));
const chanceWords = (p: number | null) => (p == null ? 'No price yet' : `${p} percent chance`);
/** "Chiefs at Bills, 62 percent chance, up 4 points since yesterday". */
const lineWords = (...parts: (string | null | false | undefined)[]) => parts.filter(Boolean).join(', ');
const moveSaid = (d: number | null | undefined, since = '') => (d == null ? '' : moveWords(d, since).toLowerCase());
const usd = (v: number) => (v < 0 ? '−' : '') + '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** A money move with its arrow and words, never a color (design.md section 8): "▲ Up $2.40 since you bought", "▼ Down $1.10 today". */
const moneyWords = (v: number, tail: string) => {
  const c = mvCls(Math.round(v * 100));
  return `${c === 'flat' ? 'No change' : `${c === 'up' ? 'Up' : 'Down'} ${usd(Math.abs(v))}`} ${tail}`;
};
function moneyMv(v: number, tail: string) {
  const c = mvCls(Math.round(v * 100));
  return `<span class="mv mv--${c} num"><span class="mv-a" aria-hidden="true">${ARROW[c]}</span> ${esc(moneyWords(v, tail))}</span>`;
}

/** One engine number in its unit, in plain words ("62%", "4 points", "61¢"). */
export function fmtNum(n: Num): string {
  switch (n.unit) {
    case 'probability':
    case 'ratio':
      return n.op === 'base_rate_history' || n.unit === 'probability' ? `${Math.round(n.value * 100)}%` : String(Math.round(n.value * 1000) / 1000);
    case 'cents':
      return `${n.op === 'expected_value' && n.value > 0 ? '+' : ''}${Math.round(n.value * 10) / 10}¢`;
    case 'points':
      return points(Math.round(n.value * 10) / 10);
    case 'dollars':
      return usd(n.value);
    case 'decimal_odds':
      return n.value.toFixed(2);
    default:
      return String(Math.round(n.value * 1000) / 1000);
  }
}

/** The number a result leads with: its chance when it has one. The order of numbers isn't a contract, so find it by op. */
export const leadNumber = (r: WidgetResult): Num | undefined => r.numbers.find((n) => n.op === 'implied_probability') ?? r.numbers[0];

const head = (t: string, sub?: string, dot?: string) =>
  `<div class="w-head"><i class="w-dot${dot ? ' ' + dot : ''}"></i><span class="w-title">${esc(DISPLAY_NAMES[t] ?? t)}</span>${sub ? `<span class="w-sub num">${esc(sub)}</span>` : ''}</div>`;

/** A small line chart. Points are real values only. */
export function spark(v: number[], o: { extra?: number[][]; area?: boolean; end?: boolean } = {}) {
  if (v.length < 2) return '';
  const ex = o.extra ?? [];
  const all = ([] as number[]).concat(v, ...ex);
  const lo = Math.min(...all) - 1.5;
  const hi = Math.max(...all) + 1.5;
  const X = (i: number, n: number) => (i / (n - 1)) * 100;
  const Y = (x: number) => 38 - ((x - lo) / (hi - lo)) * 34;
  const line = (a: number[]) => a.map((x, i) => `${X(i, a.length).toFixed(1)},${Y(x).toFixed(1)}`).join(' ');
  let s = '<div class="spark"><svg viewBox="0 0 100 42" preserveAspectRatio="none" aria-hidden="true">';
  if (o.area !== false) s += `<polygon class="ar" points="0,42 ${line(v)} 100,42"/>`;
  ex.forEach((e, i) => {
    if (e.length > 1) s += `<polyline class="l${i + 1}" points="${line(e)}"/>`;
  });
  s += `<polyline class="ln" points="${line(v)}"/></svg>`;
  if (o.end !== false) s += `<i class="end"${css(`left:100%;top:${((Y(v[v.length - 1]!) / 42) * 100).toFixed(1)}%`)}></i>`;
  return s + '</div>';
}

// ---------- reading a widget's data ----------

const quotes = (w: Widget) => w.quotes ?? [];
const quoteOf = (w: Widget, marketId: string | undefined) => (marketId ? quotes(w).find((q) => q.market_id === marketId) : undefined);
const quoteOn = (w: Widget, ex: Quote['exchange']) => quotes(w).find((q) => q.exchange === ex);
const nums = (w: Widget, op: Num['op']) => (w.result?.numbers ?? []).filter((n) => n.op === op);
const pctOf = (n: Num | undefined) => (n && n.unit === 'probability' ? Math.round(n.value * 100) : null);
const ptsOf = (n: Num | undefined) => (n ? Math.round(n.unit === 'probability' ? n.value * 100 : n.value) : null);

/** A number's receipt: how the engine got it. */
const recOf = (w: Widget, n: Num | undefined): Receipt | undefined => (n ? w.result?.receipts.find((r) => r.id === n.receipt_id) : undefined);
const argNum = (r: Receipt | undefined, k: string) => {
  const v = r?.args[k];
  return typeof v === 'number' ? v : undefined;
};
/** The markets a number was read from (its receipt's provenance: "kalshi:KX…", "polymarket:…"). */
const sourcesOf = (w: Widget, n: Num) => Object.values(recOf(w, n)?.provenance ?? {}).map((p) => p.source);
/** The number of an op read from one market, else the i-th of that op (results before provenance). */
function numFor(w: Widget, op: Num['op'], marketId: string | undefined, i: number): Num | undefined {
  const all = nums(w, op);
  if (marketId) {
    const hit = all.find((n) => sourcesOf(w, n).includes(marketId));
    if (hit) return hit;
    if (all.some((n) => sourcesOf(w, n).length)) return undefined;
  }
  return all[i];
}

/** A move from the result: its points and its window (the receipt's args.window_s). `window_s` picks one window. */
function moveOf(w: Widget, o: { window_s?: number; market?: string; i?: number } = {}): { d: number; since: string } | null {
  const cands = o.market !== undefined || o.i !== undefined ? [numFor(w, 'movement', o.market, o.i ?? 0)] : nums(w, 'movement');
  const n = cands.find((x) => x && (o.window_s === undefined || argNum(recOf(w, x), 'window_s') === o.window_s));
  return n ? { d: ptsOf(n)!, since: sinceWords(argNum(recOf(w, n), 'window_s')) } : null;
}

/** A line from the engine's price_at numbers (one point each, receipt args.ago_s), oldest first. */
function lineOf(w: Widget, market?: string): number[] {
  const pts = nums(w, 'price_at')
    .map((n) => ({ n, r: recOf(w, n) }))
    .filter(({ n }) => !market || sourcesOf(w, n).includes(market))
    .map(({ n, r }) => ({ v: n.value, ago: argNum(r, 'ago_s') ?? 0 }))
    .sort((a, b) => b.ago - a.ago);
  return pts.length >= 2 ? pts.map((p) => p.v) : [];
}
/** How far back a line from the engine reaches, in words ("7 days"). */
function lineSpan(w: Widget): string {
  const most = Math.max(0, ...nums(w, 'price_at').map((n) => argNum(recOf(w, n), 'ago_s') ?? 0));
  return most >= DAY_S ? `${Math.round(most / DAY_S)} ${Math.round(most / DAY_S) === 1 ? 'day' : 'days'}` : most >= 3600 ? `${Math.round(most / 3600)} hours` : '';
}

/**
 * The exchange prices the result's numbers were worked out from (a receipt's cents args, with their market and time),
 * over first paint's quotes once a result exists.
 */
function priceOn(w: Widget, ex: Quote['exchange']): number | null {
  for (const r of w.result?.receipts ?? []) {
    for (const [arg, p] of Object.entries(r.provenance ?? {})) {
      const v = r.args[arg];
      if (p.source.startsWith(`${ex}:`) && /cents$/.test(arg) && !/^(lo|hi)_cents$/.test(arg) && typeof v === 'number') return v;
    }
  }
  return quoteOn(w, ex)?.yes_price_cents ?? null;
}

/** A result's sentence with no numbers in it (a game that isn't paired says why), when it has one. */
const plainSummary = (w: Widget) => (w.result?.summary && !Object.keys(w.result.summary.slots).length ? w.result.summary.template : null);
/** The result's notes, as plain sentences. */
const notesHtml = (w: Widget, skip: string | null = null, cap = Infinity) =>
  (w.result?.notes ?? [])
    .filter((n) => n !== skip)
    .slice(0, cap)
    .map((n) => `<div class="w-note">${esc(n)}</div>`)
    .join('');

const EXCHANGE: Record<Quote['exchange'], string> = { kalshi: 'Kalshi', polymarket: 'Polymarket' };
const LEAGUE = /\b(?:KX)?(NFL|NBA|MLB|NHL)/i;

/**
 * A base rate in words, from its receipt: "Home teams won 51% of 121 NFL games on Kalshi this season", or "Teams priced
 * 57–67¢ before the start won 61% of 54 NFL games on Kalshi this season". The receipt's provenance names the games
 * (home teams or every team) and the exchange; its sample size is n; lo_cents and hi_cents are the band.
 */
export function baseRateWords(n: Num, r: Receipt | undefined): string | null {
  if (n.op !== 'base_rate_history' || !r) return null;
  const pct = Math.round(n.value * 100);
  const src = r.provenance?.history?.source ?? '';
  const size = r.sample_size;
  const ex = src.startsWith('kalshi:') ? ' on Kalshi' : src.startsWith('polymarket:') ? ' on Polymarket' : '';
  const league = LEAGUE.exec(src)?.[1]?.toUpperCase();
  const games = size == null ? '' : ` of ${size}${league ? ` ${league}` : ''} ${size === 1 ? 'game' : 'games'}`;
  const season = /since /.test(src) ? ' this season' : '';
  const lo = argNum(r, 'lo_cents');
  const hi = argNum(r, 'hi_cents');
  const who = lo != null && hi != null ? `Teams priced ${lo}–${hi}¢ before the start` : /home/.test(src) ? 'Home teams' : 'Teams like this';
  return `${who} won ${pct}%${games}${ex}${season}.`;
}

/** When the numbers are from: the result's market time, else the oldest quote. */
function asOf(w: Widget): { at: string; stale: boolean; from: 'result' | 'quotes' } | null {
  if (w.result) return { at: w.result.as_of, stale: w.result.stale, from: 'result' };
  const q = quotes(w);
  if (!q.length) return null;
  const oldest = q.reduce((a, b) => (a.as_of < b.as_of ? a : b));
  return { at: oldest.as_of, stale: q.some((x) => x.stale), from: 'quotes' };
}

/** "Updated just now" for a while after a refresh joined a run already asked for this minute (board.ts sets it). */
export const justNow = new Map<string, number>();
const JUST_NOW_MS = 60_000;

/**
 * When the prices are from, in plain words (design.md section 11): "Prices as of 9:41", "Prices from 2 minutes ago",
 * and when an exchange is down, "Kalshi isn't answering. Showing the last prices from 9:41."
 */
export function stampWords(w: Widget, now = Date.now()): string {
  const a = asOf(w);
  if (!a) return 'Waiting for the first prices.';
  const t = fmtTime(a.at);
  if (a.stale) {
    const down = [...new Set(quotes(w).filter((q) => q.stale).map((q) => EXCHANGE[q.exchange] ?? q.exchange))];
    const who = a.from === 'quotes' && down.length === 1 ? `${down[0]} isn’t answering` : 'An exchange isn’t answering';
    return `${who}. Showing the last prices from ${t}.`;
  }
  const j = justNow.get(w.spec.widget_id);
  if (j && now - j < JUST_NOW_MS) return `Updated just now · prices as of ${t}`;
  const min = Math.floor((now - new Date(a.at).getTime()) / 60_000);
  if (min >= 2 && min < 60) return `Prices from ${min} minutes ago · as of ${t}`;
  return `Prices as of ${t}`;
}
function stamp(w: Widget, cls = 'w-foot') {
  return `<div class="${cls} from-m">${esc(stampWords(w))}</div>`;
}

/**
 * A readable name for an event key. The board's own one-market cards carry titles ("Chiefs at Bills"); otherwise
 * the key's two team codes ("KC at BUF").
 */
export function eventLabel(key: string, titles: Map<string, string>): string {
  const t = titles.get(key);
  if (t) return t;
  const parts = key.split('-');
  const [a, b] = parts.slice(-2);
  return a && b && /^[a-z]{2,4}$/.test(a) && /^[a-z]{2,4}$/.test(b) ? `${a.toUpperCase()} at ${b.toUpperCase()}` : key;
}

/**
 * A readable name for a market id: its game's title when the board has it, else the teams in its ticker
 * ("kalshi:KXNFLGAME-26NOV08CINATL-CIN" is "CIN at ATL"; "polymarket:nfl-kc-buf-2026-11-08" is "KC at BUF").
 */
export function marketLabel(id: string, c: RenderCtx): string {
  const key = c.events?.get(id);
  if (key) return eventLabel(key, c.titles);
  const k = /^kalshi:KX[A-Z]+GAME-\d{2}[A-Z]{3}\d{2}([A-Z]+)-([A-Z]+)$/.exec(id);
  if (k && k[1]!.startsWith(k[2]!) && k[1]!.length > k[2]!.length) return `${k[2]} at ${k[1]!.slice(k[2]!.length)}`;
  const p = /^polymarket:[a-z]+-([a-z]{2,4})-([a-z]{2,4})-/.exec(id);
  if (p) return `${p[1]!.toUpperCase()} at ${p[2]!.toUpperCase()}`;
  return '';
}

export interface RenderCtx {
  /** event key -> a title from the board's one-market cards */
  titles: Map<string, string>;
  /** market id -> its event key, from the board's displays */
  events?: Map<string, string>;
}

// ---------- the six display types ----------

/** How many games a medium Tonight has room for; its subtitle says so when there are more. */
const TONIGHT_M_ROWS = 4;

function events(w: Widget, s: Display, c: RenderCtx) {
  const keys = s.params.event_keys ?? [];
  const shown = s.size === 'M' ? keys.slice(0, TONIGHT_M_ROWS) : keys;
  const rows = shown.map((k, i) => {
    const m = s.market_ids[i];
    const q = quoteOf(w, m);
    const p = pctOf(numFor(w, 'implied_probability', m, i)) ?? q?.yes_price_cents ?? null;
    const mv = moveOf(w, { market: m, i });
    const d = mv?.d ?? null;
    const name = eventLabel(k, c.titles);
    // The game's small 7-day line from the engine's price_at numbers; first paint has none.
    const line = m ? lineOf(w, m) : [];
    return `<div class="game"${says(lineWords(name, chanceWords(p), moveSaid(d, mv?.since)))}><span class="g-n">${esc(name)}</span><span class="g-s">${spark(line, { area: false, end: false })}</span><span class="g-p num">${p == null ? '—' : esc(p) + '%'}</span>${d == null ? '<span class="mv mv--flat num">—</span>' : mvEl(d)}</div>`;
  });
  return (
    head(s.title, shown.length < keys.length ? `${shown.length} of ${keys.length} games` : `${keys.length} ${keys.length === 1 ? 'game' : 'games'}`) +
    `<div class="games">${rows.join('')}</div>` +
    notesHtml(w) +
    stamp(w)
  );
}

/** "Kalshi 61 cents, Polymarket 63 cents". */
const pricesSaid = (a: number | null, b: number | null) => lineWords(a != null && spoken(`Kalshi ${a}¢`), b != null && spoken(`Polymarket ${b}¢`));

/**
 * "You think 65%: that's 4 points above the market." `ev` is the engine's expected_value, probability × 100 minus the
 * price, so its size is the distance from the market in points. The full math is in How we got this.
 */
function yourNumberLine(up: number, ev: number) {
  const pts = Math.round(Math.abs(ev));
  const you = `You think ${Math.round(up * 100)}%:`;
  if (!pts) return `<span class="ev"${says(spoken(`${you} that's the same as the market.`))}>${you} that's the same as the market.</span>`;
  const side = `${ev > 0 ? 'above' : 'below'} the market.`;
  return `<span class="ev"${says(spoken(`${you} that's ${points(pts)} ${side}`))}>${you} that's <b class="num">${esc(points(pts))}</b> ${side}</span>`;
}

function probability(w: Widget, s: Display) {
  const kc = priceOn(w, 'kalshi');
  const pc = priceOn(w, 'polymarket');
  const ip = pctOf(nums(w, 'implied_probability')[0]);
  const big = ip ?? kc ?? pc ?? null;
  // "Up 4 points since yesterday": the result's 24 h move only. First paint shows the price and no move.
  const day = moveOf(w, { window_s: DAY_S });
  const mv = day ? mvEl(day.d, { long: true, since: day.since }) : '';
  const said = lineWords(chanceWords(big), day && moveSaid(day.d, day.since), big != null && 'the market says');
  const ev = nums(w, 'expected_value')[0];
  const up = s.params.user_probability;
  // The sentence stays true of the number it reports: the "you think" the engine used, from its own receipt.
  const evUp = argNum(recOf(w, ev), 'probability') ?? up;
  const evLine = up == null ? '' : ev && evUp != null ? yourNumberLine(evUp, ev.value) : `<span class="ev">You think ${Math.round(up * 100)}%. The math for it comes with the first run.</span>`;
  const ex = [kc != null ? `<span>Kalshi <b class="num">${esc(kc)}¢</b></span>` : '', pc != null ? `<span>Polymarket <b class="num">${esc(pc)}¢</b></span>` : ''].filter(Boolean).join('<span class="sep">·</span>');
  const line = lineOf(w);
  const chart = line.length ? spark(line) : '';
  const span = line.length ? lineSpan(w) : '';
  const rates = nums(w, 'base_rate_history')
    .map((n) => baseRateWords(n, recOf(w, n)))
    .filter((x): x is string => !!x)
    .map((t) => `<div class="w-note num">${esc(t)}</div>`)
    .join('');
  return (
    // A small tile has no room for the exchanges beside the title; they are named from medium up, and in How we got this.
    head(s.title, s.size === 'S' ? undefined : [kc != null && 'Kalshi', pc != null && 'Polymarket'].filter(Boolean).join(' + ') || undefined) +
    `<div class="c-main"><div class="c-left"${says(said)}><div class="big-row"><span class="big num">${big == null ? '—' : esc(big) + '%'}</span>${big == null ? '' : '<span class="big-u">chance</span>'}</div><span class="lbl">the market says</span><div class="c-mv">${mv}</div></div><div class="c-chart">${chart}${span ? `<span class="lbl c-span">${esc(span)}</span>` : ''}</div></div>` +
    (ex ? `<div class="c-ex from-m"${says(`${pricesSaid(kc, pc)}, for a YES that pays 1 dollar`)}>${ex}<span class="lbl">for a YES that pays $1</span></div>` : '') +
    (evLine ? `<div class="c-foot from-m">${evLine}</div>` : '') +
    (rates || w.result?.notes?.length ? `<div class="c-base from-m">${rates}${notesHtml(w)}</div>` : '') +
    stamp(w, 'w-foot from-l')
  );
}

function gap(w: Widget, s: Display, c: RenderCtx) {
  const a = priceOn(w, 'kalshi');
  const b = priceOn(w, 'polymarket');
  const g = nums(w, 'gap')[0];
  const label = eventLabel(s.params.event_keys?.[0] ?? '', c.titles);
  // A small tile has no room for the game beside the title: it gets its own line, whole.
  const top = s.size === 'S' ? head(s.title) + `<div class="g-game num">${esc(label)}</div>` : head(s.title, label);
  // A game that isn't paired: no gap, and the result says why in words.
  const why = !g ? plainSummary(w) : null;
  if (why) return top + `<div class="w-note">${esc(why)}</div>` + notesHtml(w, why) + stamp(w);
  if (a == null || b == null) return top + '<div class="w-empty">Needs a price from both exchanges.</div>' + notesHtml(w) + stamp(w);
  const lo = Math.min(a, b) - 4;
  const span = Math.max(Math.abs(b - a) + 8, 8);
  const pos = (v: number) => 16 + ((v - lo) / span) * 68;
  // The gap is a distance: never negative, whichever exchange is higher.
  const gapPts = Math.abs(g ? ptsOf(g)! : b - a);
  return (
    top +
    `<div class="strand"><i class="track"></i><i class="neck"${css(`left:${pos(Math.min(a, b)).toFixed(1)}%;width:${(pos(Math.max(a, b)) - pos(Math.min(a, b))).toFixed(1)}%`)}></i><i class="bead"${css(`left:${pos(a).toFixed(1)}%`)}></i><i class="bead p"${css(`left:${pos(b).toFixed(1)}%`)}></i></div>` +
    `<div class="g-lab"${says(pricesSaid(a, b))}><span>Kalshi <b class="num">${esc(a)}¢</b></span><span>Polymarket <b class="num">${esc(b)}¢</b></span></div>` +
    `<div class="g-big"${says(gapPts === 0 ? 'The same price on both' : `The two exchanges are ${points(gapPts)} apart`)}>${gapPts === 0 ? '<span class="lbl">The same price on both</span>' : `<span class="big num">${esc(gapPts)}</span><span class="lbl">${gapPts === 1 ? 'point' : 'points'} apart</span>`}</div>` +
    notesHtml(w)
  );
}

/** How long ago, short (design.md section 6: "Sports Wire · 2 h"): "just now", "35 min", "2 h", "3 days", else the date. */
export function agoWords(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const min = Math.floor((now - t) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min`;
  if (min < 24 * 60) return `${Math.floor(min / 60)} h`;
  const days = Math.floor(min / (24 * 60));
  if (days < 7) return `${days} ${days === 1 ? 'day' : 'days'}`;
  return new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/** A slot's engine number in its format ("61%", "4 points", "61¢"). */
function slotValue(n: Num, format: string): string {
  switch (format) {
    case 'percent':
      return `${Math.round(n.value * 100)}%`;
    case 'points': {
      const v = Math.round((n.unit === 'probability' ? n.value * 100 : n.value) * 10) / 10;
      return v < 0 ? `minus ${points(-v)}` : points(v);
    }
    case 'cents':
      return `${Math.round(n.value * 10) / 10}¢`;
    case 'usd':
      return usd(n.value);
    case 'odds':
      return n.value.toFixed(2);
    default:
      return fmtNum(n);
  }
}

/**
 * A research result's summary with its slots filled by code: `{nK}` from the engine number its slot names (with that
 * number's receipt), `{qK}` from the fact's quote. The template holds no digits (the guard checks), so every number on
 * screen is the engine's. A slot that can't be filled, or a template with a digit outside a slot, shows nothing.
 */
export function summaryWords(r: WidgetResult | null | undefined): string | null {
  const sm = r?.summary;
  if (!sm || !Object.keys(sm.slots).length) return null;
  let bad = /[0-9]/.test(sm.template.replace(/\{[nq][0-9]{1,2}\}/g, ''));
  const out = sm.template.replace(/\{([nq][0-9]{1,2})\}/g, (_m, name: string) => {
    const sl = sm.slots[name];
    if (sl?.kind === 'number') {
      const n = r.numbers.find((x) => x.id === sl.number_id && x.receipt_id === sl.receipt_id);
      if (n) return slotValue(n, sl.format);
    } else if (sl?.kind === 'quote') {
      const f = r.facts.find((x) => x.fact_id === sl.fact_id);
      if (f && !r.blocked.some((b) => b.candidate_id === f.candidate_id)) return `“${f.quote.trim()}”`;
    }
    bad = true;
    return '';
  });
  return bad ? null : out.replace(/\s+/g, ' ').trim();
}

/**
 * One clean article's line: the reader's short claim, in plain words. A claim with a digit in it is the model's typing,
 * so the line is the article's own quote instead (checked against the page before it was kept).
 */
export const factLine = (f: { claim: string; quote: string }) => (/[0-9]/.test(f.claim) ? f.quote : f.claim).trim();

/**
 * How long a new News card says its first read is on its way, from the card's last change: one run's own limit
 * (RUN_RULES.timeoutsMs.run, 3 minutes) and room for the queue. board asks for that run when the card is made.
 */
const FIRST_READ_WAIT_MS = 5 * 60_000;
/** Cards whose run failed while this page was open: they stop saying "reading" (run.failed reaches us only live). */
const firstReadEnded = new Set<string>();
const firstReadArmed = new Set<string>();
let repaintFirstRead: (widget_id: string) => void = () => {};
/** The board's tile repaint, for when a card stops waiting. */
export const onFirstReadEnd = (fn: (widget_id: string) => void) => { repaintFirstRead = fn; };
export function firstReadFailed(widget_id: string) {
  firstReadEnded.add(widget_id);
  repaintFirstRead(widget_id);
}
const researchEvery = (w: Widget) => (w.profile ? w.profile.cadence.research_every_s : displayEntry('news').default_cadence.research_every_s);
// A research result means that run has ended, whatever it read.
const firstReadLeft = (w: Widget, now: number) =>
  researchEvery(w) && w.result?.kind !== 'research' && !firstReadEnded.has(w.spec.widget_id) ? Math.max(0, Date.parse(w.updated_at) + FIRST_READ_WAIT_MS - now) : 0;
/** The card repaints when its wait is over, so it never says "reading" for a run that is gone. */
function armFirstRead(w: Widget) {
  const left = firstReadLeft(w, Date.now());
  const id = w.spec.widget_id;
  if (!left || firstReadArmed.has(id)) return;
  firstReadArmed.add(id);
  setTimeout(() => {
    firstReadArmed.delete(id);
    repaintFirstRead(id);
  }, left + 50);
}

/**
 * What a News card says before it has any articles (design.md section 11: say what happens and when). While its first
 * run is on its way: that it is reading. If that run failed, was refused or never came: when runner's scheduler books
 * the next one, at the next window of the cadence (the hour, by default), and that "Refresh now" runs it at once.
 */
export function firstNewsWords(w: Widget, now = Date.now()): string {
  // A profile's own null means the user turned the schedule off.
  const every = researchEvery(w);
  if (!every) return 'The news comes when you tap ⋯ then Refresh now.';
  if (firstReadLeft(w, now)) return 'We’re reading the first articles now. It takes a minute or two.';
  const next = (Math.floor(now / 1000 / every) + 1) * every * 1000;
  const when = next - now <= 2 * 60_000 ? 'in a minute or two' : `at about ${fmtTime(new Date(next).toISOString())}`;
  return `The first news comes ${when}. To get it sooner, tap ⋯ then Refresh now.`;
}
/** "the latest articles about the Bills from Sports Wire, Weather Desk and Fan Post" (the widget's sources' outlets). */
function readFromWords(w: Widget, team: string | undefined): string {
  const ids = w.profile?.source_ids ?? displayEntry('news').default_sources;
  const outlets = [...new Set(ids.map((id) => SOURCE_CATALOG.rows.find((r) => r.source_id === id)?.outlet).filter((x): x is string => !!x))];
  const from = outlets.length > 1 ? `${outlets.slice(0, -1).join(', ')} and ${outlets.at(-1)}` : outlets[0];
  return `We read the latest articles${team ? ` about the ${team}` : ''}${from ? ` from ${from}` : ''}, each in its own sealed box, destroyed after.`;
}

/** How many items a News display shows: 2–3 (design.md section 6), a blocked page among them. A medium tile has room for one article beside a blocked page. */
const NEWS_ITEMS = 3;
const cleanCap = (size: Display['size'], blocked: number) => (blocked && size !== 'L' ? 1 : Math.max(1, NEWS_ITEMS - blocked));

/** A news item's "Sports Wire · 2 h" as a screen reader says it. */
const agoSaid = (meta: string) =>
  meta
    .replace(/ · /g, ', ')
    .replace(/\b(\d+) h$/, (_m, n: string) => (n === '1' ? '1 hour ago' : `${n} hours ago`))
    .replace(/\b(\d+) min$/, (_m, n: string) => (n === '1' ? '1 minute ago' : `${n} minutes ago`))
    .replace(/\b(\d+) days?$/, (_m, n: string) => (n === '1' ? '1 day ago' : `${n} days ago`));

function news(w: Widget, s: Display) {
  const team = s.params.team;
  const r = w.result;
  // "Bills news" already says whose news it is.
  const teamSub = team && !s.title.toLowerCase().includes(team.toLowerCase()) ? team : undefined;
  // No article read yet: a numbers run landed first, or every read failed (a spending cap refused the reader).
  if (!r || (!r.facts.length && !r.blocked.length && r.sources.every((x) => x.status === 'failed') && !w.previous?.facts.length)) {
    armFirstRead(w);
    return (
      head(s.title, teamSub) +
      `<div class="items news-wait"><div class="item"><div class="hl">${esc(firstNewsWords(w))}</div><div class="meta">${esc(readFromWords(w, team))}</div></div></div>`
    );
  }
  const src = new Map(r.sources.map((x) => [x.candidate_id, x]));
  const blockedIds = new Set(r.blocked.map((b) => b.candidate_id));
  // One line per distinct claim, from pages read clean; the same news from two outlets is one item.
  const seen = new Set<string>();
  const clean: string[] = [];
  for (const f of r.facts) {
    const so = src.get(f.candidate_id);
    if (!so || so.status !== 'read' || blockedIds.has(f.candidate_id)) continue;
    const line = factLine(f);
    const key = line.toLowerCase().replace(/[^a-z]+/g, ' ').trim();
    if (!line || seen.has(key)) continue;
    seen.add(key);
    const meta = [so.outlet ?? so.domain, agoWords(so.published_at)].filter(Boolean).join(' · ');
    // A tap opens How we got this at this article: its screenshot, outlet and time.
    clean.push(
      `<button class="item item--tap" type="button" data-cnd="${esc(f.candidate_id)}" aria-label="${esc(`${line}. ${agoSaid(meta)}. How we got this`)}"><span class="hl">${esc(line)}</span><span class="meta">${esc(meta)}</span></button>`,
    );
  }
  const blocked = r.blocked.slice(0, s.size === 'L' ? 2 : 1).map(
    (b) =>
      // Never the page's words, never its picture: the plain line and the time (design.md section 10).
      `<div class="item item--blocked"><span class="x">${IC.blocked}</span><div class="hl"><b>Blocked:</b> this page tried to trick the agent. Its sealed box was destroyed.<div class="meta num">${esc(fmtTime(b.killed_at))}</div></div></div>`,
  );
  // A medium tile keeps its one note (the guard's word on what was left out): the items make room for it.
  const room = s.size !== 'L' && r.notes?.length ? 2 - blocked.length : cleanCap(s.size, blocked.length);
  const items = clean.slice(0, Math.max(1, Math.min(room, cleanCap(s.size, blocked.length)))).concat(blocked);
  const sum = summaryWords(r);
  const body = items.length ? items.join('') : '<div class="item"><div class="hl">No news in the articles we read this time.</div></div>';
  return (
    head(s.title, teamSub ?? `${items.length} ${items.length === 1 ? 'item' : 'items'}`) +
    `<div class="items">${body}</div>` +
    // The sentence with the numbers, and when those prices are from, need a large tile: a medium one is for the items.
    (sum ? `<div class="w-note news-sum num from-l">${esc(sum)}</div>` : '') +
    notesHtml(w, null, s.size === 'L' ? Infinity : 1) +
    (sum ? stamp(w, 'w-foot from-l') : '')
  );
}

const POSITIONS_M_ROWS = 3;

/**
 * "Your account": the linked connection's balance and positions, read only. Every number is the engine's (runner's
 * positionNumbers): `balance`, and per position `value_<i>`, `pnl_<i>` and `today_<i>` (today's change, against the
 * price 24 h ago). The numbers show only while the user still shares them (consent on, connection there).
 */
function positions(w: Widget, s: Display, c: RenderCtx) {
  const con = connections().find((x) => x.connection_id === s.params.connection_id) ?? (s.params.connection_id ? undefined : connections()[0]);
  const byId = new Map((w.result?.numbers ?? []).map((n) => [n.id, n]));
  if (con && con.share_numbers && w.result && byId.size) {
    const bal = byId.get('balance');
    const rows: string[] = [];
    for (let i = 1; byId.has(`value_${i}`); i++) {
      const v = byId.get(`value_${i}`)!;
      const pnl = byId.get(`pnl_${i}`);
      const today = byId.get(`today_${i}`);
      const mkt = w.result.receipts.find((r) => r.op_id === `value_${i}`)?.provenance?.price_cents?.source ?? '';
      const name = (mkt && marketLabel(mkt, c)) || mkt.replace(/^[a-z]+:/, '');
      const mvs = [pnl ? moneyMv(pnl.value, 'since you bought') : '', today ? moneyMv(today.value, 'today') : ''].filter(Boolean).join('');
      const said = lineWords(name, `worth ${fmtNum(v)}`, pnl && moneyWords(pnl.value, 'since you bought').toLowerCase(), today && moneyWords(today.value, 'today').toLowerCase());
      rows.push(
        `<div class="pos-item"${says(spoken(said))}><div class="pos-row"><span class="pos-mkt">${esc(name)}</span><span class="num">${esc(fmtNum(v))}</span></div>` +
          (mvs ? `<div class="pos-mvs">${mvs}</div>` : '') +
          '</div>',
      );
    }
    const n = rows.length;
    // A medium tile has room for three whole positions; its count line says when there are more.
    const shown = s.size === 'M' ? rows.slice(0, POSITIONS_M_ROWS) : rows;
    return (
      head(s.title, `as of ${fmtTime(w.result.as_of)}`) +
      `<div class="pos-top"><div class="who">${esc(exchangeName(con.exchange))} <span class="pillnote">read only</span></div>` +
      `<div class="bal num"${bal ? says(spoken(`Balance ${fmtNum(bal)}`)) : ''}>${bal ? esc(fmtNum(bal)) : '—'}</div>` +
      `<div class="pos-meta"><span>${bal ? 'Balance · ' : ''}${n ? `${n} open ${n === 1 ? 'position' : 'positions'}` : 'No open positions'}${shown.length < n ? ` · ${shown.length} shown` : ''}</span><span class="num only-s">as of ${esc(fmtTime(w.result.as_of))}</span></div></div>` +
      (n ? `<div class="pos-list">${shown.join('')}</div>` : '')
    );
  }
  if (!con)
    return (
      head(s.title) +
      '<button class="acc-open" type="button" data-open-accounts><span class="who">Not connected</span>' +
      '<span class="w-empty">Tap to connect Kalshi or Polymarket, read only, in Accounts. The agent never trades.</span></button>'
    );
  // Connected, but no numbers here yet: not linked, not shared, or the first read is on its way.
  const why = !con.share_numbers
    ? 'Turn on "Let my widgets use its numbers" in Accounts to see the balance and positions here.'
    : s.params.connection_id
      ? 'Reading the balance and positions…'
      : 'No balance or positions on this display yet.';
  return (
    head(s.title) +
    `<div class="who">${esc(exchangeName(con.exchange))} <span class="pillnote">read only</span></div>` +
    `<div class="w-empty">${esc(con.exchange === 'kalshi' && con.checked_at ? `Checked with Kalshi at ${fmtTime(con.checked_at)}. We can look, never trade.` : 'Public wallet. We can look, never trade.')}</div>` +
    `<button class="acc-open" type="button" data-open-accounts><span class="w-empty">${esc(why)}</span></button>`
  );
}

function movement(w: Widget, s: Display, c: RenderCtx) {
  const q = quotes(w)[0];
  // Biggest move compares many games and keeps one: its game is the one the move's receipt was read from.
  const mvNum = nums(w, 'movement')[0];
  const src = mvNum ? sourcesOf(w, mvNum)[0] : undefined;
  const game = (src && marketLabel(src, c)) || eventLabel(s.params.event_keys?.[0] ?? '', c.titles);
  const ip = pctOf(nums(w, 'implied_probability')[0]);
  const big = ip ?? (src ? null : (q?.yes_price_cents ?? null));
  const m = moveOf(w);
  const d = m?.d ?? null;
  const since = m?.since ?? '';
  const line = lineOf(w, src);
  const fresh = w.state === 'new' ? 'is-fresh' : undefined;
  return (
    head(s.title, fresh ? 'new' : undefined, fresh) +
    `<div class="mvt"${says(lineWords(game, chanceWords(big), moveSaid(d, since)))}><span class="lbl">${esc(game)}</span><div class="row1"><span class="big num">${big == null ? '—' : esc(big) + '%'}</span>${big == null ? '' : '<span class="big-u">chance</span>'}</div>${d == null ? '' : `<div class="c-mv">${mvEl(d, { long: true, since })}</div>`}<div class="c-chart">${spark(line)}</div></div>` +
    notesHtml(w)
  );
}

/** The inside of a display tile. */
export function displayHtml(w: Widget, c: RenderCtx): string {
  const s = w.spec as Display;
  switch (s.type) {
    case 'events':
      return events(w, s, c);
    case 'probability':
      return probability(w, s);
    case 'gap':
      return gap(w, s, c);
    case 'news':
      return news(w, s);
    case 'positions':
      return positions(w, s, c);
    case 'movement':
      return movement(w, s, c);
    default:
      return head(s.title);
  }
}

/** A one-market card's headline number and move (folder previews and the open folder). */
export function cardNumbers(w: Widget): { p: number | null; d: number | null; line: number[] } {
  const q = quoteOn(w, 'kalshi') ?? quotes(w)[0];
  const ip = pctOf(nums(w, 'implied_probability')[0]);
  const line = lineOf(w);
  return { p: ip ?? q?.yes_price_cents ?? null, d: moveOf(w, { window_s: DAY_S })?.d ?? ptsOf(nums(w, 'movement')[0]) ?? null, line };
}

export function cardHtml(w: Widget, i: number): string {
  const { p, d, line } = cardNumbers(w);
  return `<div class="card rz"${css(`--i:${i}`)}><div class="top"${says(lineWords(chanceWords(p), moveSaid(d)))}><span class="p num">${p == null ? '—' : esc(p) + '%'}</span>${d == null ? '' : mvEl(d)}</div><div class="n">${esc(tileName(w))}</div><div class="c-chart">${spark(line, { end: false })}</div></div>`;
}

export function miniHtml(w: Widget): string {
  const { p } = cardNumbers(w);
  return `<span class="mini num"${says(lineWords(tileName(w), chanceWords(p)))}>${p == null ? '—' : esc(p)}<s>%</s></span>`;
}
