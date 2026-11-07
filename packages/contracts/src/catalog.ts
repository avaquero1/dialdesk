import { z } from 'zod';
import { EventKey, MarketId } from './common.ts';
import { SourceId } from './sources.ts';

/** The engine ops, as the Rust engine names them (engine --schema, OpName). */
export const EngineOp = z.enum([
  'implied_probability',
  'price_to_odds',
  'odds_to_probability',
  'expected_value',
  'movement',
  'volatility',
  'gap',
  'base_rate',
  'base_rate_history',
  'position_value',
  'pnl',
]);

export const DisplayType = z.enum(['events', 'probability', 'gap', 'news', 'positions', 'movement']);
export type DisplayType = z.infer<typeof DisplayType>;
export const AppId = z.enum(['trust', 'receipts', 'accounts', 'catalog', 'settings']);
export type AppId = z.infer<typeof AppId>;
export const WidgetKind = z.enum(['app', 'display', 'folder']);
/** S 2x2, M 4x2, L 4x4, XL 8x4 (desktop only). Apps and folders are 1x1. */
export const DisplaySize = z.enum(['S', 'M', 'L', 'XL']);
export type DisplaySize = z.infer<typeof DisplaySize>;
export const SIZE_CELLS = { S: [2, 2], M: [4, 2], L: [4, 4], XL: [8, 4] } as const;

export const Cadence = z
  .object({
    numbers_every_s: z.number().int().min(60).max(3600).nullable().describe('null = no numbers runs'),
    research_every_s: z.number().int().min(900).max(86400).nullable().describe('null = no research runs'),
  })
  .strict();
export type Cadence = z.infer<typeof Cadence>;

/** Display parameters. Which ones a type uses is listed in its catalog entry. */
export const DisplayParams = z
  .object({
    event_keys: z.array(EventKey).max(12).optional(),
    team: z.string().max(40).optional().describe('news: the team the user follows'),
    user_probability: z.number().min(0).max(1).optional().describe("probability: the user's own probability for EV"),
    threshold_pts: z.number().min(1).max(50).optional().describe('movement: raise movement.flagged past this move'),
    window_s: z.number().int().min(3600).max(30 * 86400).optional(),
    connection_id: z.string().optional().describe('positions: the connected account'),
  })
  .strict();
export type DisplayParams = z.infer<typeof DisplayParams>;

export const DisplayTypeEntry = z
  .object({
    type: DisplayType,
    title: z.string(),
    description: z.string(),
    default_size: DisplaySize,
    sizes: z.array(DisplaySize),
    engine_ops: z.array(EngineOp),
    params: z.array(DisplayParams.keyof()),
    needs_markets: z.boolean(),
    research: z.boolean().describe('true = research runs read sources'),
    default_cadence: Cadence,
    default_sources: z.array(SourceId),
  })
  .strict();

export const AppEntry = z.object({ app: AppId, title: z.string(), description: z.string() }).strict();

/** A tile of a board as the catalog prescribes it (no ids yet: board assigns them). */
export const DefaultTile = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('display'),
      type: DisplayType,
      size: DisplaySize,
      title: z.string(),
      market_ids: z.array(MarketId),
      params: DisplayParams,
    })
    .strict(),
  z.object({ kind: z.literal('app'), app: AppId, title: z.string() }).strict(),
  z
    .object({
      kind: z.literal('folder'),
      title: z.string(),
      children: z.array(
        z
          .object({
            kind: z.literal('display'),
            type: DisplayType,
            size: DisplaySize,
            title: z.string(),
            market_ids: z.array(MarketId),
            params: DisplayParams,
          })
          .strict(),
      ),
    })
    .strict(),
]);
export type DefaultTile = z.infer<typeof DefaultTile>;

export const WidgetCatalog = z
  .object({
    version: z.literal(0),
    displays: z.array(DisplayTypeEntry),
    apps: z.array(AppEntry),
    default_board: z.object({ category: z.literal('sports'), tiles: z.array(DefaultTile) }),
  })
  .strict();
export type WidgetCatalog = z.infer<typeof WidgetCatalog>;

const HOUR = 3600;
const k = (t: string) => `kalshi:${t}` as const;
const p = (s: string) => `polymarket:${s}` as const;

/** Made-up markets that match fixtures/markets (event_key -> both exchanges). */
export const FIXTURE_EVENTS = {
  'nfl-2026w10-kc-buf': { title: 'Chiefs at Bills', kalshi: k('KXNFLGAME-26NOV08KCBUF-KC'), polymarket: p('nfl-kc-buf-2026-11-08') },
  'nba-2026-11-07-lal-bos': { title: 'Lakers at Celtics', kalshi: k('KXNBAGAME-26NOV07LALBOS-LAL'), polymarket: p('nba-lal-bos-2026-11-07') },
  'nfl-2026w10-phi-dal': { title: 'Eagles at Cowboys', kalshi: k('KXNFLGAME-26NOV08PHIDAL-PHI'), polymarket: p('nfl-phi-dal-2026-11-08') },
  'nba-2026-11-07-nyk-mia': { title: 'Knicks at Heat', kalshi: k('KXNBAGAME-26NOV07NYKMIA-NYK'), polymarket: p('nba-nyk-mia-2026-11-07') },
  'nfl-2026w10-gb-chi': { title: 'Packers at Bears', kalshi: k('KXNFLGAME-26NOV08GBCHI-GB'), polymarket: p('nfl-gb-chi-2026-11-08') },
  'nfl-2026w10-sf-sea': { title: '49ers at Seahawks', kalshi: k('KXNFLGAME-26NOV08SFSEA-SF'), polymarket: p('nfl-sf-sea-2026-11-08') },
  'nba-2026-11-07-den-phx': { title: 'Nuggets at Suns', kalshi: k('KXNBAGAME-26NOV07DENPHX-DEN'), polymarket: p('nba-den-phx-2026-11-07') },
} as const;
const ev = FIXTURE_EVENTS;
const both = (key: keyof typeof ev) => [ev[key].kalshi, ev[key].polymarket];
const card = (key: keyof typeof ev) => ({
  kind: 'display' as const,
  type: 'probability' as const,
  size: 'S' as const,
  title: ev[key].title,
  market_ids: both(key),
  params: { event_keys: [key] },
});

/** The widget catalog v0, with the prescribed default board from planning/ui/PLAN.md. */
export const WIDGET_CATALOG: WidgetCatalog = {
  version: 0,
  displays: [
    {
      type: 'events',
      title: 'Tonight',
      description: "Upcoming events, each with its market's implied probability and 24 h move.",
      default_size: 'L',
      sizes: ['M', 'L', 'XL'],
      engine_ops: ['implied_probability', 'movement'],
      params: ['event_keys', 'window_s'],
      needs_markets: true,
      research: false,
      default_cadence: { numbers_every_s: 120, research_every_s: null },
      default_sources: [],
    },
    {
      type: 'probability',
      title: 'Market',
      description: 'One market on both exchanges, a 7-day line, and EV at your probability.',
      default_size: 'M',
      sizes: ['S', 'M', 'L'],
      engine_ops: ['implied_probability', 'expected_value', 'movement'],
      params: ['event_keys', 'user_probability', 'window_s'],
      needs_markets: true,
      research: false,
      default_cadence: { numbers_every_s: 120, research_every_s: null },
      default_sources: [],
    },
    {
      type: 'gap',
      title: 'Gap',
      description: "The same event's price on Kalshi and Polymarket, and the gap.",
      default_size: 'S',
      sizes: ['S', 'M'],
      engine_ops: ['gap'],
      params: ['event_keys'],
      needs_markets: true,
      research: false,
      default_cadence: { numbers_every_s: 120, research_every_s: null },
      default_sources: [],
    },
    {
      type: 'news',
      title: 'Team news',
      description: 'Items with outlet and time, summaries with slots, and blocked items.',
      default_size: 'M',
      sizes: ['M', 'L'],
      engine_ops: ['implied_probability', 'movement'],
      params: ['team', 'event_keys'],
      needs_markets: true,
      research: true,
      default_cadence: { numbers_every_s: null, research_every_s: HOUR },
      default_sources: ['src-sportswire', 'src-weatherdesk', 'src-fanpost'],
    },
    {
      type: 'positions',
      title: 'Positions',
      description: "A connected account, read only: balance, positions and today's P&L. Shows its scope.",
      default_size: 'S',
      sizes: ['S', 'M'],
      engine_ops: ['position_value', 'pnl'],
      params: ['connection_id'],
      needs_markets: false,
      research: false,
      default_cadence: { numbers_every_s: 300, research_every_s: null },
      default_sources: [],
    },
    {
      type: 'movement',
      title: 'Movement',
      description: "One market's move and a small line.",
      default_size: 'S',
      sizes: ['S', 'M'],
      engine_ops: ['movement', 'volatility'],
      params: ['event_keys', 'threshold_pts', 'window_s'],
      needs_markets: true,
      research: false,
      default_cadence: { numbers_every_s: 120, research_every_s: null },
      default_sources: [],
    },
  ],
  apps: [
    { app: 'trust', title: 'Trust', description: 'Sandboxes today, blocked requests, killed runs, the audit head.' },
    { app: 'receipts', title: 'Receipts', description: 'Every number on the board and how it was computed.' },
    { app: 'accounts', title: 'Accounts', description: 'Connect Kalshi or Polymarket, read only.' },
    { app: 'catalog', title: 'Catalog', description: 'Add a widget by hand.' },
    { app: 'settings', title: 'Settings', description: 'Look, plan and account.' },
  ],
  default_board: {
    category: 'sports',
    tiles: [
      {
        kind: 'display',
        type: 'events',
        size: 'L',
        title: 'Tonight',
        market_ids: [ev['nfl-2026w10-kc-buf'].kalshi, ev['nba-2026-11-07-lal-bos'].kalshi, ev['nfl-2026w10-phi-dal'].kalshi, ev['nba-2026-11-07-nyk-mia'].kalshi],
        params: { event_keys: ['nfl-2026w10-kc-buf', 'nba-2026-11-07-lal-bos', 'nfl-2026w10-phi-dal', 'nba-2026-11-07-nyk-mia'], window_s: 86400 },
      },
      {
        kind: 'display',
        type: 'probability',
        size: 'M',
        title: 'Chiefs beat the Bills',
        market_ids: both('nfl-2026w10-kc-buf'),
        params: { event_keys: ['nfl-2026w10-kc-buf'], user_probability: 0.65, window_s: 7 * 86400 },
      },
      { kind: 'display', type: 'gap', size: 'S', title: 'Gap', market_ids: both('nfl-2026w10-kc-buf'), params: { event_keys: ['nfl-2026w10-kc-buf'] } },
      {
        kind: 'display',
        type: 'news',
        size: 'M',
        title: 'Bills news',
        market_ids: both('nfl-2026w10-kc-buf'),
        params: { team: 'Bills', event_keys: ['nfl-2026w10-kc-buf'] },
      },
      { kind: 'display', type: 'positions', size: 'S', title: 'Positions', market_ids: [], params: {} },
      {
        kind: 'display',
        type: 'movement',
        size: 'S',
        title: 'Movement',
        market_ids: [ev['nba-2026-11-07-lal-bos'].kalshi],
        params: { event_keys: ['nba-2026-11-07-lal-bos'], threshold_pts: 5, window_s: 86400 },
      },
      {
        kind: 'folder',
        title: 'NFL Week 10',
        children: [card('nfl-2026w10-kc-buf'), card('nfl-2026w10-phi-dal'), card('nfl-2026w10-gb-chi'), card('nfl-2026w10-sf-sea')],
      },
      {
        kind: 'folder',
        title: 'NBA Tonight',
        children: [card('nba-2026-11-07-lal-bos'), card('nba-2026-11-07-nyk-mia'), card('nba-2026-11-07-den-phx')],
      },
      { kind: 'app', app: 'trust', title: 'Trust' },
      { kind: 'app', app: 'receipts', title: 'Receipts' },
      { kind: 'app', app: 'accounts', title: 'Accounts' },
      { kind: 'app', app: 'catalog', title: 'Catalog' },
      { kind: 'app', app: 'settings', title: 'Settings' },
    ],
  },
};

export function displayEntry(type: DisplayType) {
  const e = WIDGET_CATALOG.displays.find((d) => d.type === type);
  if (!e) throw new Error(`no catalog entry for ${type}`);
  return e;
}
