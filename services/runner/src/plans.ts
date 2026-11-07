/**
 * Math plans, by code. The numbers a plan may read come only from markets (prices and history) and from the user's
 * own spec (user_probability, window_s). A plan from the planner is checked against the widget's catalog entry; one
 * that fails is refused whole and the default plan for the type runs instead.
 */
import { CONNECTIONS, EnginePlan, MARKETS, displayEntry, type DisplayType, type EngineInput, type Market, type WidgetSpec } from '@app/contracts';
import { CallError, type Call } from '@app/service-kit';

type DisplaySpec = Extract<WidgetSpec, { kind: 'display' }>;
type Op = EnginePlan['ops'][number];
type Value = number | { t: number; v: number }[];
type Origins = NonNullable<EngineInput['origins']>;

/**
 * Ops no plan may use yet. base_rate_history needs resolved results, and markets has no resolved-history endpoint;
 * base_rate needs hits and totals from the same place.
 */
export const NOT_YET_OPS = new Set<string>(['base_rate', 'base_rate_history']);

/** The ops a type's plans may use: its catalog ops, less NOT_YET_OPS. */
export const allowedOps = (type: DisplayType) => displayEntry(type).engine_ops.filter((o) => !NOT_YET_OPS.has(o));

const DAY = 86400;
export const MAX_OPS = 16;

/** Keys a plan may read. price_<i> / series_<i> follow spec.market_ids (1-based); kalshi_* and polymarket_* alias the first of each. */
export function numberKeys(spec: DisplaySpec): string[] {
  const keys = ['window_s'];
  spec.market_ids.forEach((m, i) => keys.push(`price_${i + 1}`, `series_${i + 1}`));
  for (const ex of ['kalshi', 'polymarket'] as const)
    if (spec.market_ids.some((m) => m.startsWith(`${ex}:`))) keys.push(`${ex}_price`, `${ex}_series`);
  if (spec.params.user_probability !== undefined) keys.push('user_probability');
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
    if (n >= 1) add('movement', { series: 'series_1', window_s: 'window_s' });
  } else if (type === 'gap') {
    if (has(spec, 'kalshi') && has(spec, 'polymarket')) add('gap', { a_cents: 'kalshi_price', b_cents: 'polymarket_price' });
  } else if (type === 'news') {
    if (n >= 1) {
      add('implied_probability', { price_cents: 'price_1' });
      add('movement', { series: 'series_1', window_s: 'window_s' });
    }
  } else if (type === 'movement') {
    if (n >= 1) {
      add('movement', { series: 'series_1', window_s: 'window_s' });
      add('volatility', { series: 'series_1' });
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
    for (const ref of Object.values(op.args)) if (!keys.has(ref) && !ids.has(ref)) return `unknown input ${ref}`;
    ids.add(op.id);
  }
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
  /** Where and when each input was read (gap: both prices' markets and quote times), copied onto the receipts. */
  provenance?: NonNullable<EngineInput['provenance']>;
  quotes: Market[];
  /** The oldest market time among the quotes. */
  as_of: string;
  stale: boolean;
  /** Market ids markets couldn't answer for (503 or 404). */
  down: string[];
}

/** Prices (and history, when the plan reads a series) from markets. A market that is down is left out. */
export async function marketNumbers(markets: Call, spec: DisplaySpec, plan: EnginePlan | null): Promise<MarketNumbers> {
  const want = plan ? planInputs(plan) : null;
  const window_s = spec.params.window_s ?? DAY;
  const numbers: Record<string, Value> = { window_s };
  const origins: Origins = { window_s: 'user' };
  if (spec.params.user_probability !== undefined) {
    numbers.user_probability = spec.params.user_probability;
    origins.user_probability = 'user';
  }
  const put = (key: string, v: Value, o: Origins[string]) => {
    numbers[key] = v;
    origins[key] = o;
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
        put(`price_${k}`, m.yes_price_cents, 'market');
        if (firstOfExchange) put(`${ex}_price`, m.yes_price_cents, 'market');
      } catch (e) {
        if (e instanceof CallError && (e.status === 503 || e.status === 404)) return void down.push(market_id);
        throw e;
      }
      const needSeries = !want || want.has(`series_${k}`) || (firstOfExchange && want.has(`${ex}_series`));
      if (!needSeries) return;
      try {
        const h = await markets(MARKETS.history, { params: { market_id }, query: { window_s: Math.max(window_s, 3600) } });
        const series = h.points.map((p) => ({ t: p.t, v: p.price_cents }));
        if (series.length) {
          put(`series_${k}`, series, 'history');
          if (firstOfExchange) put(`${ex}_series`, series, 'history');
        }
      } catch (e) {
        if (!(e instanceof CallError && (e.status === 503 || e.status === 404))) throw e;
      }
    }),
  );
  const got = quotes.filter(Boolean);
  const as_of = got.length ? got.map((q) => q.as_of).sort()[0]! : new Date().toISOString();
  return { numbers, origins, quotes: got, as_of, stale: got.some((q) => q.stale), down };
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

/** Positions shown per widget, at most. */
export const MAX_POSITIONS = 6;

/**
 * A positions widget's inputs: the user's positions from connections (only with the user's consent: 403 otherwise,
 * which means "not connected", not an error) and each position's current price from markets. count_<i> and
 * avg_price_<i> are tagged `connection`, pos_price_<i> `market`. `skip` says why there is nothing to compute.
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
  const ops: Op[] = [];
  const quotes: Market[] = [];
  const down: string[] = [];
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
    const price = p.side === 'yes' ? m.yes_price_cents : 100 - m.yes_price_cents;
    numbers[`count_${i}`] = p.count;
    origins[`count_${i}`] = 'connection';
    numbers[`avg_price_${i}`] = p.avg_price_cents;
    origins[`avg_price_${i}`] = 'connection';
    numbers[`pos_price_${i}`] = price;
    origins[`pos_price_${i}`] = 'market';
    ops.push({ id: `n${ops.length + 1}`, op: 'position_value', args: { count: `count_${i}`, price_cents: `pos_price_${i}` } });
    ops.push({ id: `n${ops.length + 1}`, op: 'pnl', args: { count: `count_${i}`, avg_price_cents: `avg_price_${i}`, price_cents: `pos_price_${i}` } });
  }
  if (!ops.length) return { skip: pos.positions.length ? 'no position has a price' : 'no open positions' };
  const as_of = [pos.as_of, ...quotes.map((q) => q.as_of)].sort()[0]!;
  return { plan: { plan_version: 1, ops }, mn: { numbers, origins, quotes, as_of, stale: quotes.some((q) => q.stale), down } };
}
