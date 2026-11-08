/**
 * Renders a widget from its spec and data: a result when one exists, else the first-paint quotes board copied from
 * markets (exchange prices with their "as of" time). Every value is escaped; nothing here renders HTML from the
 * server or from a model. The words follow the house rules: implied probability, movement, expected value.
 */
import type { Quote, Widget, WidgetResult } from '@app/contracts';
import { css, esc } from './dom.ts';
import { IC } from './icons.ts';

type Num = WidgetResult['numbers'][number];
type Display = Extract<Widget['spec'], { kind: 'display' }>;

/** The apps' names on screen (design section 6); the inside names (trust, receipts, catalog) stay in code. */
export const APP_NAMES: Record<string, string> = { trust: 'Safety', receipts: 'How we got it', accounts: 'Accounts', catalog: 'Add', settings: 'Settings' };
/** A tile's name on screen: an app's plain name, else its title. */
export const tileName = (w: Widget) => (w.spec.kind === 'app' ? (APP_NAMES[w.spec.app] ?? w.spec.title) : w.spec.title);

// ---------- small formatters ----------

export const fmtTime = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
};
const fmtMove = (d: number) => (d > 0 ? `▲${d}` : d < 0 ? `▼${-d}` : '— 0');
const mvCls = (d: number) => (d > 0 ? 'up' : d < 0 ? 'down' : 'flat');
const mvEl = (d: number, tail = '') => `<span class="mv mv--${mvCls(d)} num">${esc(fmtMove(d))}${esc(tail)}</span>`;
const usd = (v: number) => (v < 0 ? '−' : '') + '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signedUsd = (v: number) => (v > 0 ? '+' : '') + usd(v);

/** One engine number in its unit. */
export function fmtNum(n: Num): string {
  switch (n.unit) {
    case 'probability':
      return `${Math.round(n.value * 100)}%`;
    case 'cents':
      return `${n.value > 0 ? '+' : ''}${Math.round(n.value * 10) / 10}¢`;
    case 'points':
      return `${Math.round(n.value * 10) / 10} pts`;
    case 'dollars':
      return usd(n.value);
    case 'decimal_odds':
      return n.value.toFixed(2);
    default:
      return String(Math.round(n.value * 1000) / 1000);
  }
}

const head = (t: string, sub?: string, dot?: string) =>
  `<div class="w-head"><i class="w-dot${dot ? ' ' + dot : ''}"></i><span class="w-title">${esc(t)}</span>${sub ? `<span class="w-sub num">${esc(sub)}</span>` : ''}</div>`;

/** A small line chart. Points are real values only (first paint has two: 24 h ago and now). */
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
const move = (q: Quote | undefined) => (q && q.previous_price_cents != null ? q.yes_price_cents - q.previous_price_cents : null);
const line2 = (q: Quote | undefined) => (q && q.previous_price_cents != null ? [q.previous_price_cents, q.yes_price_cents] : []);
const pctOf = (n: Num | undefined) => (n && n.unit === 'probability' ? Math.round(n.value * 100) : null);
const ptsOf = (n: Num | undefined) => (n ? Math.round(n.unit === 'probability' ? n.value * 100 : n.value) : null);

/** When the numbers are from: the result's market time, else the oldest quote. */
function asOf(w: Widget): { at: string; stale: boolean; from: 'result' | 'quotes' } | null {
  if (w.result) return { at: w.result.as_of, stale: w.result.stale, from: 'result' };
  const q = quotes(w);
  if (!q.length) return null;
  const oldest = q.reduce((a, b) => (a.as_of < b.as_of ? a : b));
  return { at: oldest.as_of, stale: q.some((x) => x.stale), from: 'quotes' };
}
const EXCHANGE: Record<Quote['exchange'], string> = { kalshi: 'Kalshi', polymarket: 'Polymarket' };

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

export interface RenderCtx {
  /** event key -> a title from the board's one-market cards */
  titles: Map<string, string>;
}

// ---------- the six display types ----------

function events(w: Widget, s: Display, c: RenderCtx) {
  const keys = s.params.event_keys ?? [];
  const ip = nums(w, 'implied_probability');
  const mv = nums(w, 'movement');
  const rows = keys.map((k, i) => {
    const q = quoteOf(w, s.market_ids[i]);
    const p = pctOf(ip[i]) ?? q?.yes_price_cents ?? null;
    const d = ptsOf(mv[i]) ?? move(q);
    return `<div class="game"><span class="g-n">${esc(eventLabel(k, c.titles))}</span><span class="g-s">${spark(line2(q), { area: false, end: false })}</span><span class="g-p num">${p == null ? '—' : esc(p) + '%'}</span>${d == null ? '<span class="mv mv--flat num">—</span>' : mvEl(d)}</div>`;
  });
  return (
    head(s.title, `${keys.length} ${keys.length === 1 ? 'game' : 'games'}`) +
    `<div class="games">${rows.join('')}</div>` +
    stamp(w)
  );
}

function probability(w: Widget, s: Display) {
  const k = quoteOn(w, 'kalshi');
  const p = quoteOn(w, 'polymarket');
  const ip = pctOf(nums(w, 'implied_probability')[0]);
  const big = ip ?? k?.yes_price_cents ?? p?.yes_price_cents ?? null;
  const bigLabel = ip != null ? 'Implied probability' : k ? 'Kalshi price, implied' : 'Implied probability';
  const d = ptsOf(nums(w, 'movement')[0]) ?? move(k) ?? move(p);
  const ev = nums(w, 'expected_value')[0];
  const up = s.params.user_probability;
  const evLine =
    up == null
      ? ''
      : ev
        ? `<span class="ev">At your ${Math.round(up * 100)}%: EV <b class="num">${esc(fmtNum(ev))}</b> <span>per contract</span></span><span class="pillnote">receipt ${esc(ev.receipt_id)}</span>`
        : `<span class="ev">At your ${Math.round(up * 100)}%: EV after the first run</span>`;
  const ex = [k ? `<span>Kalshi <b class="num">${esc(k.yes_price_cents)}¢</b></span>` : '', p ? `<span>Polymarket <b class="num">${esc(p.yes_price_cents)}¢</b></span>` : ''].join('');
  const chart = line2(k).length ? spark(line2(k), { extra: [line2(k), line2(p)] }) : '';
  return (
    head(s.title, [k && 'Kalshi', p && 'Polymarket'].filter(Boolean).join(' + ') || undefined) +
    `<div class="c-main"><div class="c-left"><span class="lbl">${bigLabel}</span><div class="big num">${big == null ? '—' : esc(big) + '%'}</div><div>${d == null ? '' : mvEl(d, ' pts') + ' <span class="lbl">in 24 h</span>'}</div></div><div class="c-chart">${chart}</div></div>` +
    (ex ? `<div class="c-ex from-m">${ex}<span class="lbl">24 h</span></div>` : '') +
    (evLine ? `<div class="c-foot from-m">${evLine}</div>` : '') +
    stamp(w, 'w-foot from-l')
  );
}

function gap(w: Widget, s: Display, c: RenderCtx) {
  const k = quoteOn(w, 'kalshi');
  const p = quoteOn(w, 'polymarket');
  const g = nums(w, 'gap')[0];
  const label = eventLabel(s.params.event_keys?.[0] ?? '', c.titles);
  if (!k || !p) return head(s.title, label) + '<div class="w-empty">Needs a price from both exchanges.</div>' + stamp(w);
  const a = k.yes_price_cents;
  const b = p.yes_price_cents;
  const lo = Math.min(a, b) - 4;
  const span = Math.max(Math.abs(b - a) + 8, 8);
  const pos = (v: number) => 16 + ((v - lo) / span) * 68;
  const gapPts = g ? ptsOf(g)! : Math.abs(b - a);
  return (
    head(s.title, label) +
    `<div class="strand"><i class="track"></i><i class="neck"${css(`left:${pos(Math.min(a, b)).toFixed(1)}%;width:${(pos(Math.max(a, b)) - pos(Math.min(a, b))).toFixed(1)}%`)}></i><i class="bead"${css(`left:${pos(a).toFixed(1)}%`)}></i><i class="bead p"${css(`left:${pos(b).toFixed(1)}%`)}></i></div>` +
    `<div class="g-lab"><span>Kalshi <b class="num">${esc(a)}</b></span><span>Polymarket <b class="num">${esc(b)}</b></span></div><div class="g-big"><span class="big num">${esc(gapPts)}</span><span class="lbl">${gapPts === 1 ? 'pt' : 'pts'} apart</span></div>`
  );
}

function news(w: Widget, s: Display) {
  const team = s.params.team;
  const r = w.result;
  if (!r) {
    return (
      head(s.title, team ? `${team}` : undefined) +
      `<div class="items"><div class="item"><div class="hl">Articles are read on the first research run.</div><div class="meta">Each one in its own sealed box, destroyed after.</div></div></div>`
    );
  }
  const src = new Map(r.sources.map((x) => [x.candidate_id, x]));
  const items = r.facts.slice(0, 3).map((f) => {
    const so = src.get(f.candidate_id);
    const meta = [so?.outlet ?? so?.domain, so?.published_at ? fmtTime(so.published_at) : null].filter(Boolean).join(' · ');
    return `<div class="item"><div class="hl">${esc(f.claim)}</div><div class="meta">${esc(meta)}</div></div>`;
  });
  const blocked = r.blocked.map(
    (b) =>
      // Never the page's words: the plain line and the time (design.md section 10).
      `<div class="item item--blocked"><span class="x">${IC.blocked}</span><div class="hl"><b>Blocked:</b> this page tried to trick the agent. Its sealed box was destroyed.<div class="meta num">${esc(fmtTime(b.killed_at))}</div></div></div>`,
  );
  const n = r.facts.length + r.blocked.length;
  return head(s.title, `${n} ${n === 1 ? 'item' : 'items'}`) + `<div class="items">${items.join('')}${blocked.join('')}</div>`;
}

function positions(w: Widget, s: Display) {
  const v = nums(w, 'position_value')[0];
  const pnl = nums(w, 'pnl')[0];
  if (!s.params.connection_id || !w.result) {
    return (
      head(s.title) +
      '<div class="who">No account connected</div>' +
      '<div class="w-empty">Connect Kalshi or Polymarket, read only, in Accounts. The agent never trades.</div>'
    );
  }
  return (
    head(s.title) +
    '<div class="who">Connected <span class="pillnote">read only</span></div>' +
    `<div class="bal num">${v ? esc(fmtNum(v)) : '—'}</div>` +
    `<div class="pos-meta">${pnl ? `<span class="mv mv--${mvCls(pnl.value)} num">${esc(signedUsd(pnl.value))} today</span>` : ''}</div>`
  );
}

function movement(w: Widget, s: Display, c: RenderCtx) {
  const q = quotes(w)[0];
  const ip = pctOf(nums(w, 'implied_probability')[0]);
  const big = ip ?? q?.yes_price_cents ?? null;
  const d = ptsOf(nums(w, 'movement')[0]) ?? move(q);
  const fresh = w.state === 'new' ? 'is-fresh' : undefined;
  return (
    head(s.title, fresh ? 'new' : undefined, fresh) +
    `<div class="mvt"><span class="lbl">${esc(eventLabel(s.params.event_keys?.[0] ?? '', c.titles))}</span><div class="row1"><span class="big num">${big == null ? '—' : esc(big) + '%'}</span>${d == null ? '' : mvEl(d)}</div><div class="c-chart">${spark(line2(q))}</div></div>`
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
      return positions(w, s);
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
  return { p: ip ?? q?.yes_price_cents ?? null, d: ptsOf(nums(w, 'movement')[0]) ?? move(q), line: line2(q) };
}

export function cardHtml(w: Widget, i: number): string {
  const { p, d, line } = cardNumbers(w);
  return `<div class="card rz"${css(`--i:${i}`)}><div class="top"><span class="p num">${p == null ? '—' : esc(p) + '%'}</span>${d == null ? '' : mvEl(d)}</div><div class="n">${esc(w.spec.title)}</div><div class="c-chart">${spark(line, { end: false })}</div></div>`;
}

export function miniHtml(w: Widget): string {
  const { p } = cardNumbers(w);
  return `<span class="mini num">${p == null ? '—' : esc(p)}<s>%</s></span>`;
}
