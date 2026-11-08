/**
 * Math plans, by code. The numbers a plan may read come only from markets (prices and history) and from the user's
 * own spec (user_probability, window_s). A plan from the planner is checked against the widget's catalog entry; one
 * that fails is refused whole and the default plan for the type runs instead.
 */
import { CONNECTIONS, ENGINE_OP_ARGS, EnginePlan, MARKETS, displayEntry, type DisplayType, type EngineInput, type EngineResult, type Market, type ResultSince, type WidgetResult, type WidgetSpec } from '@app/contracts';
import { CallError, type Call } from '@app/service-kit';

type DisplaySpec = Extract<WidgetSpec, { kind: 'display' }>;
type Op = EnginePlan['ops'][number];
type Value = number | { t: number; v: number }[] | { t: number; price_cents: number; outcome: number }[];
type Origins = NonNullable<EngineInput['origins']>;
type Provenance = NonNullable<EngineInput['provenance']>;

/**
 * Ops no plan may use. base_rate takes hits and totals, which only a count by code could give: base rates come from
 * base_rate_history, which counts the settled games itself (markets.resolved).
 */
export const NOT_YET_OPS = new Set<string>(['base_rate']);

/** Settled games a base rate needs, at least: with fewer, the widget says so in words and shows no number. */
export const MIN_BASE_RATE_N = 30;
/** The price band of "teams priced near this one": the market's price, this many cents either side. */
export const BAND_CENTS = 5;
const BASE_RATE_KEYS = ['home_history', 'band_history', 'band_lo', 'band_hi'];

/** The ops a type's plans may use: its catalog ops, less NOT_YET_OPS. */
export const allowedOps = (type: DisplayType) => displayEntry(type).engine_ops.filter((o) => !NOT_YET_OPS.has(o));

const DAY = 86400;
export const MAX_OPS = 16;
/** Points on a line (the Market's 7-day line, Biggest move's small line): ago_1 is window_s back, ago_<LINE_POINTS> is now. */
export const LINE_POINTS = 8;
const LINE_KEYS = Array.from({ length: LINE_POINTS }, (_, j) => `ago_${j + 1}`);
/** How far back each line point is, in seconds: evenly spaced over the window, the last one now. */
export const lineAgo = (window_s: number) => LINE_KEYS.map((_, j) => Math.round((window_s * (LINE_POINTS - 1 - j)) / (LINE_POINTS - 1)));

/**
 * Keys a plan may read. price_<i> / series_<i> follow spec.market_ids (1-based); kalshi_* and polymarket_* alias the first
 * of each. day_s is 24 h ("since yesterday"); ago_<j> are the line's points over window_s.
 */
export function numberKeys(spec: DisplaySpec): string[] {
  const keys = ['window_s', 'day_s', ...LINE_KEYS];
  spec.market_ids.forEach((m, i) => keys.push(`price_${i + 1}`, `series_${i + 1}`));
  for (const ex of ['kalshi', 'polymarket'] as const)
    if (spec.market_ids.some((m) => m.startsWith(`${ex}:`))) keys.push(`${ex}_price`, `${ex}_series`);
  if (spec.params.user_probability !== undefined) keys.push('user_probability');
  // A Market's base rates: home teams' wins, and teams priced near this one (band_lo..band_hi), this season.
  if (spec.type === 'probability' && spec.market_ids.length) keys.push(...BASE_RATE_KEYS);
  return keys;
}

/** The default plan for a type, from its catalog ops. positions builds its plan from the connection (positionNumbers). */
export function defaultPlan(spec: DisplaySpec): EnginePlan {
  const ops: Op[] = [];
  const add = (op: Op['op'], args: Op['args']) => ops.push({ id: `n${ops.length + 1}`, op, args });
  const n = spec.market_ids.length;
  const type: DisplayType = spec.type;
  if (type === 'events') {
    for (let i = 1; i <= Math.min(n, 6); i++) {
      add('implied_probability', { price_cents: `price_${i}` });
      add('movement', { series: `series_${i}`, window_s: 'window_s' });
    }
  } else if (type === 'probability') {
    if (n >= 1) add('implied_probability', { price_cents: 'price_1' });
    if (n >= 2) add('implied_probability', { price_cents: 'price_2' });
    // EV takes its probability only from the user (F8), never from a model.
    if (n >= 1 && spec.params.user_probability !== undefined) add('expected_value', { price_cents: 'price_1', probability: 'user_probability' });
    // "Up 4 points since yesterday", then the 7-day line (window_s): its points, oldest first.
    if (n >= 1) add('movement', { series: 'series_1', window_s: 'day_s' });
    if (n >= 1) for (const k of LINE_KEYS) add('price_at', { series: 'series_1', ago_s: k });
    // Base rates from this season's settled games: how often the home team won, and how often a team priced near
    // this market before the start won.
    if (n >= 1) {
      add('base_rate_history', { history: 'home_history' });
      add('base_rate_history', { history: 'band_history', lo_cents: 'band_lo', hi_cents: 'band_hi' });
    }
  } else if (type === 'gap') {
    if (has(spec, 'kalshi') && has(spec, 'polymarket')) add('gap', { a_cents: 'kalshi_price', b_cents: 'polymarket_price' });
  } else if (type === 'news') {
    if (n >= 1) {
      add('implied_probability', { price_cents: 'price_1' });
      add('movement', { series: 'series_1', window_s: 'window_s' });
    }
  } else if (type === 'movement') {
    // One game's move (Biggest move has its own plan: biggestMoveNumbers) and its small line over the window.
    if (n >= 1) {
      add('movement', { series: 'series_1', window_s: 'window_s' });
      add('volatility', { series: 'series_1' });
      for (const k of LINE_KEYS) add('price_at', { series: 'series_1', ago_s: k });
    }
  }
  return { plan_version: 1, ops };
}

const has = (spec: DisplaySpec, ex: string) => spec.market_ids.some((m) => m.startsWith(`${ex}:`));

/** Why a plan is refused, or null when it fits the catalog entry and reads only known keys. */
export function planProblem(spec: DisplaySpec, plan: unknown): string | null {
  const p = EnginePlan.safeParse(plan);
  if (!p.success) return 'not a plan';
  if (p.data.plan_version !== 1) return 'plan_version';
  if (!p.data.ops.length || p.data.ops.length > MAX_OPS) return 'op count';
  const allowed = new Set<string>(allowedOps(spec.type));
  const keys = new Set(numberKeys(spec));
  const ids = new Set<string>();
  for (const op of p.data.ops) {
    if (!/^n[0-9]{1,2}$/.test(op.id) || ids.has(op.id)) return `op id ${op.id}`;
    if (!allowed.has(op.op)) return `op ${op.op} is not in the catalog for ${spec.type}`;
    const problem = argProblem(op);
    if (problem) return problem;
    for (const ref of Object.values(op.args)) if (!keys.has(ref) && !ids.has(ref)) return `unknown input ${ref}`;
    ids.add(op.id);
  }
  return null;
}

/**
 * An op's arg names against the engine's own op schema (`engine --schema`, "ops"): an arg the op doesn't take, or a
 * required one left out, makes the engine compute nothing (the real planner wrote {"price": ...} for {"price_cents": ...}).
 */
export function argProblem(op: Op): string | null {
  const want = ENGINE_OP_ARGS[op.op];
  if (!want) return `op ${op.op} is not an engine op`;
  const names = new Set(want.map((a) => a.name));
  const takes = want.map((a) => a.name).join(', ');
  for (const name of Object.keys(op.args)) if (!names.has(name)) return `op ${op.id} (${op.op}) has no arg ${name}; it takes ${takes}`;
  for (const a of want) if (a.required && !(a.name in op.args)) return `op ${op.id} (${op.op}) needs arg ${a.name}`;
  return null;
}

/** The keys a plan reads from `numbers`. */
export const planInputs = (plan: EnginePlan) => {
  const ids = new Set(plan.ops.map((o) => o.id));
  return new Set(plan.ops.flatMap((o) => Object.values(o.args)).filter((k) => !ids.has(k)));
};

export interface MarketNumbers {
  numbers: Record<string, Value>;
  /** Where each input came from: market for prices, history for series, user for the widget's own settings. */
  origins: Origins;
  /** Where and when each price and series was read (its market and quote or fetch time), copied onto the receipts. */
  provenance?: Provenance;
  quotes: Market[];
  /** The oldest market time among the quotes. */
  as_of: string;
  stale: boolean;
  /** Market ids markets couldn't answer for (503 or 404). */
  down: string[];
  /** Plain words, no digits, for a number left out on purpose (a base rate whose sample is too small). */
  notes?: string[];
}

/** Prices (and history, when the plan reads a series) from markets. A market that is down is left out. */
export async function marketNumbers(markets: Call, spec: DisplaySpec, plan: EnginePlan | null): Promise<MarketNumbers> {
  const want = plan ? planInputs(plan) : null;
  const window_s = spec.params.window_s ?? DAY;
  const numbers: Record<string, Value> = { window_s };
  const origins: Origins = { window_s: 'user' };
  const provenance: Provenance = {};
  // Fixed spans by code: untagged numbers (no op takes a probability from them).
  // The line spans window_s; a Market (a folder's card names none) draws 7 days.
  const lineWindow = spec.params.window_s ?? (spec.type === 'probability' ? 7 * DAY : DAY);
  if (!want || want.has('day_s')) numbers.day_s = DAY;
  lineAgo(lineWindow).forEach((ago, j) => {
    if (!want || want.has(LINE_KEYS[j]!)) numbers[LINE_KEYS[j]!] = ago;
  });
  const drawsLine = LINE_KEYS.some((k) => k in numbers);
  const historyWindow = Math.max(window_s, 'day_s' in numbers ? DAY : 0, drawsLine ? lineWindow : 0, 3600);
  if (spec.params.user_probability !== undefined) {
    numbers.user_probability = spec.params.user_probability;
    origins.user_probability = 'user';
  }
  const put = (key: string, v: Value, o: Origins[string] | undefined, from: Provenance[string]) => {
    numbers[key] = v;
    if (o) origins[key] = o;
    provenance[key] = from;
  };
  const quotes: Market[] = [];
  const down: string[] = [];
  await Promise.all(
    spec.market_ids.map(async (market_id, i) => {
      const k = i + 1;
      const ex = market_id.split(':')[0]!;
      const firstOfExchange = spec.market_ids.findIndex((m) => m.startsWith(`${ex}:`)) === i;
      try {
        const m = await markets(MARKETS.get, { params: { market_id } });
        quotes[i] = m;
        const from = { source: m.market_id, as_of: m.as_of };
        put(`price_${k}`, m.yes_price_cents, 'market', from);
        if (firstOfExchange) put(`${ex}_price`, m.yes_price_cents, 'market', from);
      } catch (e) {
        if (e instanceof CallError && (e.status === 503 || e.status === 404)) return void down.push(market_id);
        throw e;
      }
      const needSeries = !want || want.has(`series_${k}`) || (firstOfExchange && want.has(`${ex}_series`));
      if (!needSeries) return;
      try {
        const h = await markets(MARKETS.history, { params: { market_id }, query: { window_s: historyWindow } });
        const series = h.points.map((p) => ({ t: p.t, v: p.price_cents }));
        if (series.length) {
          const from = { source: h.market_id, as_of: h.as_of };
          put(`series_${k}`, series, 'history', from);
          if (firstOfExchange) put(`${ex}_series`, series, 'history', from);
        }
      } catch (e) {
        if (!(e instanceof CallError && (e.status === 503 || e.status === 404))) throw e;
      }
    }),
  );
  const notes: string[] = [];
  const wantsBase = spec.type === 'probability' && (!want || BASE_RATE_KEYS.some((k) => want.has(k)));
  if (wantsBase && quotes[0]) notes.push(...(await baseRateNumbers(markets, quotes[0], put)));
  const got = quotes.filter(Boolean);
  const as_of = got.length ? got.map((q) => q.as_of).sort()[0]! : new Date().toISOString();
  return { numbers, origins, provenance, quotes: got, as_of, stale: got.some((q) => q.stale), down, ...(notes.length ? { notes } : {}) };
}

const LEAGUE_NAME: Record<string, string> = { nfl: 'NFL', nba: 'NBA' };

/**
 * A Market's base-rate inputs from markets' settled games of its league this season (markets.resolved): home_history
 * (each game's home-team market) and band_history (every team's market) with band_lo..band_hi around the market's own
 * price. The engine counts them (base_rate_history) and its receipt holds the sample size; runner only checks there
 * are enough (MIN_BASE_RATE_N). An input with too few games is left out, so its op doesn't run, and the returned note
 * says why in words. Every input carries its source (the exchange's series, which games, since when) and time.
 */
export async function baseRateNumbers(
  markets: Call,
  m: Market,
  put: (key: string, v: Value, o: Origins[string] | undefined, from: Provenance[string]) => void,
): Promise<string[]> {
  const name = m.league ? LEAGUE_NAME[m.league] : undefined;
  if (!name || !m.event_key) return [];
  let h;
  try {
    h = await markets(MARKETS.resolved, { query: { league: m.league!, kind: 'game_winner' } });
  } catch (e) {
    if (e instanceof CallError && e.status === 404) return [];
    if (e instanceof CallError && e.status === 503) return ["No base rates right now: the exchange's settled games aren't answering."];
    throw e;
  }
  const ex = h.exchange === 'kalshi' ? 'Kalshi' : 'Polymarket';
  const loading = h.left_out.pending > 0;
  const tooFew = (what: string) =>
    loading ? `The ${what} base rate is still loading: ${ex}'s settled games are read a few at a time.` : `Too few ${name} games have settled on ${ex} this season for the ${what} base rate.`;
  const asRecords = (rs: typeof h.records) => rs.map((r) => ({ t: r.t, price_cents: r.price_cents, outcome: r.outcome }));
  const notes: string[] = [];
  const home = h.records.filter((r) => r.home);
  if (home.length >= MIN_BASE_RATE_N)
    put('home_history', asRecords(home), 'history', { source: `${h.exchange}:${h.series} settled, home teams, since ${h.season_start}`, as_of: h.as_of });
  else notes.push(tooFew('home-team'));
  const lo = Math.max(0, m.yes_price_cents - BAND_CENTS);
  const hi = Math.min(100, m.yes_price_cents + BAND_CENTS);
  const inBand = h.records.filter((r) => r.price_cents >= lo && r.price_cents <= hi).length;
  if (inBand >= MIN_BASE_RATE_N) {
    put('band_history', asRecords(h.records), 'history', { source: `${h.exchange}:${h.series} settled, every team, since ${h.season_start}`, as_of: h.as_of });
    const from = { source: m.market_id, as_of: m.as_of };
    put('band_lo', lo, undefined, from);
    put('band_hi', hi, undefined, from);
  } else notes.push(loading ? tooFew('price') : `Too few ${name} teams this season were priced near this one before the start for a base rate.`);
  return notes;
}

/** The plan without the ops whose inputs are missing (a market down, no history), and without ops that read them. */
export function runnablePlan(plan: EnginePlan, numbers: Record<string, unknown>): EnginePlan {
  const ok = new Set(Object.keys(numbers));
  const ops: Op[] = [];
  for (const op of plan.ops) {
    if (Object.values(op.args).every((ref) => ok.has(ref))) {
      ops.push(op);
      ok.add(op.id);
    }
  }
  return { plan_version: 1, ops };
}

/** A gap widget's plan, always: Polymarket's YES price minus Kalshi's, both from the event's pair. */
export const GAP_PLAN: EnginePlan = { plan_version: 1, ops: [{ id: 'n1', op: 'gap', args: { a_cents: 'kalshi_price', b_cents: 'polymarket_price' } }] };

/**
 * A gap widget's inputs. The two prices come from the pair markets made for the widget's event (both YES meaning the
 * same team wins), never from whichever ids the spec lists, and each carries where and when it was read: the engine
 * copies that onto the receipt. `skip` is the reason in plain words when the game isn't paired.
 */
export async function gapNumbers(markets: Call, spec: DisplaySpec): Promise<{ plan: EnginePlan; mn: MarketNumbers } | { skip: string }> {
  let event_key = spec.params.event_keys?.[0];
  if (!event_key) {
    for (const market_id of spec.market_ids) {
      const m = await markets(MARKETS.get, { params: { market_id } }).catch(() => null);
      if (m?.event_key) {
        event_key = m.event_key;
        break;
      }
    }
  }
  if (!event_key) return { skip: "Not compared: this widget doesn't name a game." };
  let ev;
  try {
    ev = await markets(MARKETS.event, { params: { event_key } });
  } catch (e) {
    if (e instanceof CallError && e.status === 404) return { skip: "Not compared: neither exchange lists this game." };
    if (e instanceof CallError && e.status === 503) {
      const none = { numbers: {}, origins: {}, quotes: [], as_of: new Date().toISOString(), stale: true };
      return { plan: GAP_PLAN, mn: { ...none, down: spec.market_ids.length ? [...spec.market_ids] : ['kalshi', 'polymarket'] } };
    }
    throw e;
  }
  const pairing = ev.pairing;
  if (!pairing) return { skip: "Not compared: we couldn't check that both exchanges mean the same team on YES." };
  if (!pairing.paired) return { skip: `Not compared: ${pairing.reason}` };
  const k = ev.markets.find((m) => m.market_id === pairing.kalshi);
  const p = ev.markets.find((m) => m.market_id === pairing.polymarket);
  if (!k || !p) return { skip: 'Not compared: one of the two prices is missing.' };
  const numbers: Record<string, Value> = { kalshi_price: k.yes_price_cents, polymarket_price: p.yes_price_cents };
  const origins: Origins = { kalshi_price: 'market', polymarket_price: 'market' };
  const provenance = { kalshi_price: { source: k.market_id, as_of: k.as_of }, polymarket_price: { source: p.market_id, as_of: p.as_of } };
  const as_of = [k.as_of, p.as_of].sort()[0]!;
  return { plan: GAP_PLAN, mn: { numbers, origins, provenance, quotes: [k, p], as_of, stale: k.stale || p.stale, down: [] } };
}

/**
 * Biggest move: the board's own movement tile (it keeps the catalog's title), or one that lists several games. A
 * movement widget the agent made for one game ("Lakers at Celtics move") shows that game.
 */
export const isBiggestMove = (spec: DisplaySpec) => spec.type === 'movement' && (spec.market_ids.length > 1 || spec.title === displayEntry('movement').title);

/** Games Biggest move compares, at most (the most traded first). */
export const MAX_MOVERS = 8;

const GAME_DAY = /^(?:nfl|nba)-(\d{4}-\d{2}-\d{2})-([a-z]+)-([a-z]+)$/;

/**
 * The games Biggest move compares: the widget's own markets when it lists several (the games on the user's board),
 * else tonight's games, one market per game (Kalshi's away-team market, as the board picks it, else Polymarket's).
 * "Tonight" is the ET day of the widget's own game, else the first day with games from markets' list.
 */
export async function moverIds(markets: Call, spec: DisplaySpec): Promise<string[]> {
  if (spec.market_ids.length > 1) return spec.market_ids.slice(0, MAX_MOVERS);
  let list: Market[];
  try {
    list = (await markets(MARKETS.list, { query: { category: 'sports' } })).markets;
  } catch (e) {
    if (e instanceof CallError && e.status === 503) return spec.market_ids;
    throw e;
  }
  const games = new Map<string, { day: string; id: string; volume: number; kalshi: boolean }>();
  for (const m of list) {
    const k = m.event_key ? GAME_DAY.exec(m.event_key) : null;
    if (!k) continue;
    const away = m.exchange === 'kalshi' && m.market_id.endsWith(`-${k[2]!.toUpperCase()}`);
    if (m.exchange === 'kalshi' && !away) continue;
    const g = games.get(m.event_key!);
    if (!g || (away && !g.kalshi)) games.set(m.event_key!, { day: k[1]!, id: m.market_id, volume: (g?.volume ?? 0) + m.volume, kalshi: away });
    else g.volume += m.volume;
  }
  const own = spec.params.event_keys?.[0] ? GAME_DAY.exec(spec.params.event_keys[0])?.[1] : undefined;
  const days = [...new Set([...games.values()].map((g) => g.day))].sort();
  const day = own && days.includes(own) ? own : days[0];
  const tonight = [...games.values()].filter((g) => g.day === day).sort((a, b) => b.volume - a.volume || a.id.localeCompare(b.id));
  const ids = tonight.slice(0, MAX_MOVERS).map((g) => g.id);
  for (const id of spec.market_ids) if (!ids.includes(id)) ids.splice(Math.min(ids.length, MAX_MOVERS - 1), 1, id);
  return ids.length ? ids : spec.market_ids;
}

/**
 * Biggest move's inputs and plan: for each game, its chance, its move over window_s and its small line. The engine
 * computes them all; pickBiggest keeps the game whose move is largest.
 */
export async function biggestMoveNumbers(markets: Call, spec: DisplaySpec): Promise<{ plan: EnginePlan; mn: MarketNumbers; ids: string[] }> {
  const ids = await moverIds(markets, spec);
  const all = { ...spec, market_ids: ids };
  const ops: Op[] = [];
  const add = (op: Op['op'], args: Op['args']) => ops.push({ id: `n${ops.length + 1}`, op, args });
  ids.forEach((_, i) => {
    add('implied_probability', { price_cents: `price_${i + 1}` });
    add('movement', { series: `series_${i + 1}`, window_s: 'window_s' });
    for (const k of LINE_KEYS) add('price_at', { series: `series_${i + 1}`, ago_s: k });
  });
  const plan: EnginePlan = { plan_version: 1, ops };
  return { plan, mn: await marketNumbers(markets, all, plan), ids };
}

/**
 * Of the engine's moves, the largest by size (the first, by the order games were listed, on a tie), with that game's
 * other numbers: every number and receipt kept is the engine's own, unchanged. null when no game has a move.
 */
export function pickBiggest(er: EngineResult): EngineResult | null {
  const moves = er.numbers.filter((n) => n.op === 'movement');
  if (!moves.length) return null;
  const best = moves.reduce((a, b) => (Math.abs(b.value) > Math.abs(a.value) ? b : a));
  const series = er.receipts.find((r) => r.id === best.receipt_id)?.refs?.series;
  const mine = new Set(er.receipts.filter((r) => Object.values(r.refs ?? {}).some((ref) => ref === series || ref === series?.replace('series_', 'price_'))).map((r) => r.id));
  const keep = (id: string) => mine.has(id);
  const numbers = er.numbers.filter((n) => keep(n.receipt_id));
  // The move first: board's movement flag and the display read the first movement number.
  numbers.sort((a, b) => (a.op === 'movement' ? -1 : b.op === 'movement' ? 1 : 0));
  return { ...er, numbers, receipts: er.receipts.filter((r) => keep(r.id)) };
}

/** Positions shown per widget, at most. */
export const MAX_POSITIONS = 6;

/**
 * A "Your account" (positions) widget's inputs: the user's balance and positions from connections (only with the
 * user's consent: 403 otherwise, which means "not connected", not an error) and each position's current and 24 h old
 * price from markets. Every shown number comes out of the engine with a receipt:
 * - `balance`: position_value of balance_cents at 1¢ a cent (cents to dollars).
 * - `value_<i>` and `pnl_<i>`: the position's value now and its P&L against the average price paid.
 * - `today_<i>`: today's change, the same pnl against the price 24 h ago (when markets has one).
 * The account's numbers are tagged `connection`, with provenance "<exchange> account, read only" and connections'
 * time; prices are tagged `market`, with their market and quote time.
 */
export async function positionNumbers(
  connections: Call | undefined,
  markets: Call,
  spec: DisplaySpec,
): Promise<{ plan: EnginePlan; mn: MarketNumbers } | { skip: string }> {
  const connection_id = spec.params.connection_id;
  if (!connection_id || !connections) return { skip: 'no connected account' };
  let pos;
  try {
    pos = await connections(CONNECTIONS.numbers, { params: { connection_id }, query: { account_id: spec.account_id } });
  } catch (e) {
    if (e instanceof CallError && (e.status === 403 || e.status === 404)) return { skip: 'not connected (numbers not shared)' };
    throw e;
  }
  const numbers: Record<string, Value> = {};
  const origins: Origins = {};
  const provenance: Provenance = {};
  const ops: Op[] = [];
  const quotes: Market[] = [];
  const down: string[] = [];
  // Only Kalshi reports a cash balance; a wallet's positions name their exchange in the market id.
  const exchange = pos.positions[0]?.market_id.split(':')[0] ?? (pos.balance_cents !== null ? 'kalshi' : 'exchange');
  const account = { source: `${exchange === 'kalshi' ? 'Kalshi' : exchange === 'polymarket' ? 'Polymarket' : exchange} account, read only`, as_of: pos.as_of };
  const fromAccount = (key: string, v: number) => {
    numbers[key] = v;
    origins[key] = 'connection';
    provenance[key] = account;
  };
  const fromMarket = (key: string, v: number, m: Market) => {
    numbers[key] = v;
    origins[key] = 'market';
    provenance[key] = { source: m.market_id, as_of: m.as_of };
  };
  if (pos.balance_cents !== null && pos.balance_cents >= 0) {
    fromAccount('balance_cents', pos.balance_cents);
    numbers.cents_per_cent = 1; // a constant set by code: untagged
    ops.push({ id: 'balance', op: 'position_value', args: { count: 'balance_cents', price_cents: 'cents_per_cent' } });
  }
  let i = 0;
  for (const p of pos.positions) {
    if (i >= MAX_POSITIONS || p.count === 0) continue;
    let m: Market;
    try {
      m = await markets(MARKETS.get, { params: { market_id: p.market_id } });
    } catch (e) {
      if (e instanceof CallError && (e.status === 503 || e.status === 404)) {
        down.push(p.market_id);
        continue;
      }
      throw e;
    }
    i++;
    quotes.push(m);
    const side = (c: number) => (p.side === 'yes' ? c : 100 - c);
    fromAccount(`count_${i}`, p.count);
    fromAccount(`avg_price_${i}`, p.avg_price_cents);
    fromMarket(`pos_price_${i}`, side(m.yes_price_cents), m);
    ops.push({ id: `value_${i}`, op: 'position_value', args: { count: `count_${i}`, price_cents: `pos_price_${i}` } });
    ops.push({ id: `pnl_${i}`, op: 'pnl', args: { count: `count_${i}`, avg_price_cents: `avg_price_${i}`, price_cents: `pos_price_${i}` } });
    if (m.previous_price_cents !== null) {
      fromMarket(`prev_price_${i}`, side(m.previous_price_cents), m);
      ops.push({ id: `today_${i}`, op: 'pnl', args: { count: `count_${i}`, avg_price_cents: `prev_price_${i}`, price_cents: `pos_price_${i}` } });
    }
  }
  if (!ops.length) return { skip: pos.positions.length ? 'no position has a price' : 'no balance and no open positions' };
  const as_of = [pos.as_of, ...quotes.map((q) => q.as_of)].sort()[0]!;
  return { plan: { plan_version: 1, ops }, mn: { numbers, origins, provenance, quotes, as_of, stale: quotes.some((q) => q.stale), down } };
}

// ---------- "since you last looked" (N1.2.1) ----------

/** Moves per widget, at most (ResultSince's limit). */
export const MAX_SINCE = 12;
const SINCE_OP = /^since_\d+$/;

/**
 * "Since you last looked": for each price the plan turns into a chance, the engine's move from the baseline's price of
 * the same market, a `gap` op (b_cents now minus a_cents then, in points). The baseline is the result the owner saw at
 * the previous visit (board's getWidget). Its price is the one on its own receipt, tagged market, with that receipt's
 * market and quote time, so the new receipt holds both prices and both times. Nothing when there is no baseline.
 */
export function sinceInputs(
  baseline: WidgetResult | null | undefined,
  plan: EnginePlan,
  input: Pick<EngineInput, 'numbers' | 'provenance'>,
): { ops: Op[]; numbers: Record<string, number>; origins: Origins; provenance: Provenance } {
  const out = { ops: [] as Op[], numbers: {} as Record<string, number>, origins: {} as Origins, provenance: {} as Provenance };
  if (!baseline) return out;
  const taken = new Set([...plan.ops.map((o) => o.id), ...Object.keys(input.numbers)]);
  const done = new Set<string>();
  for (const op of plan.ops) {
    if (op.op !== 'implied_probability' || out.ops.length >= MAX_SINCE) continue;
    const key = op.args.price_cents;
    const now = key ? input.provenance?.[key] : undefined;
    if (!key || !now || typeof input.numbers[key] !== 'number' || done.has(now.source)) continue;
    const then = baseline.receipts.find((r) => r.op === 'implied_probability' && r.provenance?.price_cents?.source === now.source);
    const was = then?.args.price_cents;
    if (!then || typeof was !== 'number') continue;
    const k = out.ops.length + 1;
    const id = `since_${k}`;
    const from = `since_from_${k}`;
    if (taken.has(id) || taken.has(from)) break;
    done.add(now.source);
    out.numbers[from] = was;
    out.origins[from] = 'market';
    out.provenance[from] = then.provenance!.price_cents!;
    out.ops.push({ id, op: 'gap', args: { a_cents: from, b_cents: key } });
  }
  return out;
}

/** The since moves out of an engine result (the widget's own numbers stay as they were), as the result's `since`. */
export function splitSince(er: EngineResult, from_result_id: string | undefined): { er: EngineResult; since: ResultSince | null } {
  const mine = er.numbers.filter((n) => SINCE_OP.test(n.id));
  if (!mine.length && !er.errors.some((e) => SINCE_OP.test(e.op_id))) return { er, since: null };
  const ids = new Set(mine.map((n) => n.receipt_id));
  const rest = {
    ...er,
    numbers: er.numbers.filter((n) => !SINCE_OP.test(n.id)),
    receipts: er.receipts.filter((r) => !ids.has(r.id)),
    errors: er.errors.filter((e) => !SINCE_OP.test(e.op_id)),
  };
  rest.ok = rest.errors.length === 0;
  const since = from_result_id && mine.length ? { from_result_id, numbers: mine, receipts: er.receipts.filter((r) => ids.has(r.id)) } : null;
  return { er: rest, since };
}
