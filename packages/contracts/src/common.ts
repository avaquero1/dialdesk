import { z } from 'zod';

/** The 9 TypeScript services. sandbox-manager is Rust and owns its own schema (see rust.ts). */
export const SERVICES = [
  'edge',
  'accounts',
  'board',
  'agent',
  'runner',
  'markets',
  'connections',
  'models',
  'audit',
] as const;
export const ServiceName = z.enum(SERVICES);
export type ServiceName = z.infer<typeof ServiceName>;

/** Everyone who can appear as a caller: the services, sandbox-manager's caller list, and the browser (through edge). */
export const Caller = z.enum([...SERVICES, 'browser', 'public']);
export type Caller = z.infer<typeof Caller>;

/** The services that store data: one Postgres role `svc_<name>` and one schema `<name>` each (deploy/db-init.sql). */
export const DATA_SERVICES = ['accounts', 'board', 'agent', 'runner', 'markets', 'connections', 'models', 'audit'] as const;

/** Local dev ports. Production uses the same ports inside each container. */
export const PORTS = {
  edge: 8080,
  accounts: 8101,
  board: 8102,
  agent: 8103,
  runner: 8104,
  markets: 8105,
  connections: 8106,
  models: 8107,
  audit: 8108,
  'sandbox-manager': 8200,
  'egress-proxy': 8201,
  fixtures: 8300,
} as const;

const idOf = (prefix: string) =>
  z
    .string()
    .regex(new RegExp(`^${prefix}_[A-Za-z0-9]{8,32}$`))
    .describe(`id with prefix ${prefix}_`);

export const AccountId = idOf('acc');
export const SessionId = idOf('ses');
export const WidgetId = idOf('wid');
export const ProposalId = idOf('prp');
export const RunId = idOf('run');
export const ResultId = idOf('res');
export const VerdictId = idOf('vrd');
export const ConversationId = idOf('cnv');
export const TurnId = idOf('trn');
export const ConnectionId = idOf('con');
export const AuditRowId = idOf('aud');
export const FactId = z.string().regex(/^f[0-9]{1,3}$/).describe('fact id inside one result, e.g. f1');
export const CandidateId = idOf('cnd');
/** Receipt ids come from the Rust engine: "r-" + 8 hex. */
export const ReceiptId = z.string().regex(/^r-[0-9a-f]{8}$/);
/** Market ids: `kalshi:<TICKER>` or `polymarket:<slug>`. */
export const MarketId = z.string().regex(/^(kalshi:[A-Z0-9-]{3,80}|polymarket:[a-z0-9-]{3,120})$/);
export type MarketId = z.infer<typeof MarketId>;
/** One real-world event that can have a market on both exchanges, e.g. nfl-2026w10-kc-buf. */
export const EventKey = z.string().regex(/^[a-z0-9-]{3,80}$/);
export const Exchange = z.enum(['kalshi', 'polymarket']);
export const Domain = z
  .string()
  .regex(/^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/)
  .describe('lower-case host name, no scheme, no port');
export const Timestamp = z.iso.datetime({ offset: true });
export const HttpsUrl = z.url({ protocol: /^https$/ });
/** Dev and test fixtures are served over http on localhost; production accepts https only. */
export const SourceUrl = z.url({ protocol: /^https?$/ });
export const Cents = z.number().int().min(0).max(100);

export const ApiError = z.object({
  error: z.string(),
  message: z.string(),
});
export type ApiError = z.infer<typeof ApiError>;

export const Ok = z.object({ ok: z.literal(true) });

export const Health = z.object({
  ok: z.boolean(),
  service: z.string(),
  version: z.string(),
  mode: z.enum(['real', 'fake']),
});
export type Health = z.infer<typeof Health>;

/** Id generator shared by fakes and services, so ids always match the patterns above. */
export function newId(prefix: string): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let s = '';
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return `${prefix}_${s}`;
}
