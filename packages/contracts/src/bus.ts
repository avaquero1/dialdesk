/**
 * Everything on Valkey: job queues (BullMQ), events (pub/sub) and the log stream, plus each service's ACL.
 * deploy/.dev/valkey-users.acl is generated from VALKEY_ACL by scripts/dev-secrets.ts.
 */
import { z } from 'zod';
import {
  AccountId,
  AuditRowId,
  ConnectionId,
  ResultId,
  RunId,
  ServiceName,
  Timestamp,
  WidgetId,
} from './common.ts';
import { Look } from './look.ts';
import { RunKind, RunTraceStep } from './result.ts';

// ---------- Jobs (BullMQ, prefix "bull") ----------

export const BULL_PREFIX = 'bull';
export const QUEUES = {
  /** board -> runner (and runner's scheduler -> runner): one widget run. */
  widgetRuns: 'widget-runs',
  /** connections -> connections: refresh one connected account's balances and positions. */
  accountRefresh: 'account-refresh',
} as const;

export const RunReason = z.enum(['accept', 'schedule', 'refresh', 'movement', 'clear']);

/** Job id = widget id + kind + schedule window, so duplicates collapse. */
export function widgetRunJobId(widgetId: string, kind: RunKind, windowStart: number): string {
  return `${widgetId}:${kind}:${windowStart}`;
}

/** runner never trusts this payload: it reloads the spec from board by id and rebuilds the allowlist from the catalog. */
export const WidgetRunJob = z
  .object({
    job_id: z.string().regex(/^wid_[A-Za-z0-9]+:(numbers|research):[0-9]+$/),
    widget_id: WidgetId,
    account_id: AccountId,
    kind: RunKind,
    window_start: z.number().int().describe('unix seconds; the schedule window this run belongs to'),
    reason: RunReason,
  })
  .strict();
export type WidgetRunJob = z.infer<typeof WidgetRunJob>;

export const AccountRefreshJob = z
  .object({
    job_id: z.string(),
    connection_id: ConnectionId,
    account_id: AccountId,
  })
  .strict();
export type AccountRefreshJob = z.infer<typeof AccountRefreshJob>;

export const JOBS = {
  // board enqueues on accept, refresh, clear and movement; runner's scheduler enqueues the cadence runs (reason "schedule").
  [QUEUES.widgetRuns]: { schema: WidgetRunJob, producers: ['board', 'runner'], consumers: ['runner'] },
  [QUEUES.accountRefresh]: { schema: AccountRefreshJob, producers: ['connections'], consumers: ['connections'] },
} as const;

// ---------- Events (pub/sub channel "events.<name>"; edge pushes them to the browser) ----------

const evBase = { account_id: AccountId, at: Timestamp };

export const EVENTS = {
  'widget.updated': {
    from: 'board',
    schema: z.object({ ...evBase, widget_id: WidgetId, change: z.enum(['added', 'pending', 'changed', 'removed', 'cleared']) }).strict(),
  },
  'result.updated': {
    from: 'board',
    schema: z.object({ ...evBase, widget_id: WidgetId, result_id: ResultId, phase: z.enum(['numbers', 'summary']) }).strict(),
  },
  'movement.flagged': {
    from: 'board',
    schema: z.object({ ...evBase, widget_id: WidgetId, market_id: z.string(), move_pts: z.number(), threshold_pts: z.number() }).strict(),
  },
  'run.started': {
    from: 'runner',
    schema: z.object({ ...evBase, widget_id: WidgetId, run_id: RunId, kind: RunKind }).strict(),
  },
  'run.step': {
    from: 'runner',
    schema: z.object({ ...evBase, step: RunTraceStep }).strict(),
  },
  'run.poisoned': {
    from: 'runner',
    schema: z
      .object({ ...evBase, widget_id: WidgetId, run_id: RunId, reason: z.literal('poison'), sandbox_id: z.string(), audit_row_id: AuditRowId.nullable() })
      .strict(),
  },
  'run.failed': {
    from: 'runner',
    schema: z
      .object({
        ...evBase,
        widget_id: WidgetId,
        run_id: RunId,
        reason: z.enum(['timeout', 'busy', 'exchange_down', 'model_error', 'guard_block', 'internal']),
        audit_row_id: AuditRowId.nullable(),
      })
      .strict(),
  },
  'look.changed': {
    from: 'accounts',
    schema: z.object({ ...evBase, look: Look }).strict(),
  },
  /** The account is gone (the nightly guest sweep): board, agent and connections delete its rows. */
  'account.deleted': {
    from: 'accounts',
    schema: z.object({ ...evBase, reason: z.enum(['guest_sweep']) }).strict(),
  },
} as const satisfies Record<string, { from: z.infer<typeof ServiceName>; schema: z.ZodType }>;

export type EventName = keyof typeof EVENTS;
export const EventName = z.enum(Object.keys(EVENTS) as [EventName, ...EventName[]]);
export type EventPayload<E extends EventName> = z.infer<(typeof EVENTS)[E]['schema']>;
export const EVENT_CHANNEL_PREFIX = 'events.';
export const eventChannel = (e: EventName) => `${EVENT_CHANNEL_PREFIX}${e}`;

/** What edge sends down the browser's WebSocket. Events are hints, not truth: the browser refetches on reconnect. */
export const BrowserEvent = z.object({ event: EventName, payload: z.record(z.string(), z.unknown()) }).strict();

// ---------- The log stream (one Valkey stream; audit alone reads it) ----------

export const LOG_STREAM = 'log:actions';
export const LOG_CONSUMER_GROUP = 'audit';

/** One action. Ids, hashes and sizes only: never a body of connections traffic, a model prompt or page text. */
export const LogEntry = z
  .object({
    service: z.union([ServiceName, z.literal('sandbox-manager')]),
    action: z.string().regex(/^[a-z]+(\.[a-z_]+)+$/).describe('e.g. sandbox.killed, proxy.refused, chat.turn, connection.scope_checked'),
    at: Timestamp,
    account_id: AccountId.nullable(),
    subject_id: z.string().max(120).nullable().describe('the widget, run, connection… this is about'),
    outcome: z.enum(['ok', 'refused', 'blocked', 'poisoned', 'killed', 'failed']).nullable(),
    ids: z.record(z.string(), z.string().max(120)),
    hashes: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)),
    sizes: z.record(z.string(), z.number().int().min(0)),
  })
  .strict();
export type LogEntry = z.infer<typeof LogEntry>;

// ---------- Valkey ACL: one user per service ----------

export const valkeyUser = (s: string) => `svc-${s}`;

type Acl = { queues: string[]; publish: EventName[]; subscribe: 'all' | EventName[]; logStream: 'append' | 'read' };
const pubs = (s: string) => (Object.keys(EVENTS) as EventName[]).filter((e) => EVENTS[e].from === s);

/** Which queues, channels and stream access each service gets. Services not listed don't use Valkey. */
export const VALKEY_ACL: Record<z.infer<typeof ServiceName>, Acl> = {
  edge: { queues: [], publish: [], subscribe: 'all', logStream: 'append' },
  accounts: { queues: [], publish: pubs('accounts'), subscribe: [], logStream: 'append' },
  board: { queues: [QUEUES.widgetRuns], publish: pubs('board'), subscribe: ['account.deleted'], logStream: 'append' },
  agent: { queues: [], publish: [], subscribe: ['account.deleted'], logStream: 'append' },
  runner: { queues: [QUEUES.widgetRuns], publish: pubs('runner'), subscribe: [], logStream: 'append' },
  markets: { queues: [], publish: [], subscribe: [], logStream: 'append' },
  connections: { queues: [QUEUES.accountRefresh], publish: [], subscribe: ['account.deleted'], logStream: 'append' },
  models: { queues: [], publish: [], subscribe: [], logStream: 'append' },
  audit: { queues: [], publish: [], subscribe: [], logStream: 'read' },
};

/**
 * The commands a BullMQ queue user needs, and nothing more: every command BullMQ's Lua scripts call (Valkey checks
 * each one, and each key, against the caller's ACL inside the script), plus what its client sends itself (EVALSHA,
 * EVAL and SCRIPT LOAD to run the scripts, BZPOPMIN to wait for jobs, MULTI/EXEC, INFO for its version check).
 * Read from bullmq 6.4.2's commands/*.lua and checked with ACL LOG on Valkey 8.1 (packages/service-kit/test/valkey.test.ts).
 * No category grants (+@write, +@keyspace, +@scripting): those carry key-less commands that reach every key, like
 * FLUSHALL, SWAPDB, SCRIPT FLUSH, FUNCTION LOAD and CLIENT KILL.
 */
export const BULLMQ_COMMANDS = [
  'evalsha', 'eval', 'script|load', 'multi', 'exec', 'bzpopmin',
  'exists', 'type', 'del', 'unlink', 'rename', 'get', 'set', 'incr', 'incrby', 'pexpire', 'pexpireat', 'pttl', 'time',
  'hset', 'hmset', 'hget', 'hmget', 'hgetall', 'hdel', 'hexists', 'hincrby', 'hlen',
  'lpush', 'rpush', 'lpop', 'rpop', 'rpoplpush', 'lrem', 'llen', 'lrange', 'lindex', 'lpos', 'lset', 'ltrim',
  'sadd', 'srem', 'scard', 'smembers', 'sismember',
  'zadd', 'zrem', 'zscore', 'zcard', 'zcount', 'zlexcount', 'zrange', 'zrevrange', 'zrangebyscore', 'zrevrangebyscore',
  'zrangebylex', 'zremrangebyscore', 'zremrangebyrank', 'zpopmin',
  'xadd', 'xread', 'xrange', 'xlen', 'xtrim', 'xdel',
] as const;

/** audit's commands on `log:actions`: create the group, read as a consumer, reclaim, ack, trim. */
export const LOG_READ_COMMANDS = ['xgroup|create', 'xreadgroup', 'xack', 'xpending', 'xautoclaim', 'xinfo|groups', 'xinfo|stream', 'xlen', 'xtrim', 'xrange'] as const;

/**
 * One ACL line per service (without the password part). Each user reaches only its own keys and channels:
 * `~bull:<queue>:*` for its queues, `log:actions` (append, or read for audit) and `&events.<name>` for the events it
 * publishes or reads (Valkey's `&channel` grants both). The key and channel rules hold inside BullMQ's Lua too.
 * The stream's rule is a selector `(…)`: a command passes if the root rule or the selector allows it with all its keys.
 */
export function valkeyAclRule(service: z.infer<typeof ServiceName>): string {
  const a = VALKEY_ACL[service];
  const parts: string[] = ['resetkeys', 'resetchannels', '-@all', '+ping', '+hello', '+client|setname', '+client|setinfo', '+quit'];
  for (const q of a.queues) parts.push(`~${BULL_PREFIX}:${q}:*`);
  if (a.queues.length) parts.push('+info', ...BULLMQ_COMMANDS.map((c) => `+${c}`));
  // A selector, so the queue commands above (DEL, XTRIM, PEXPIRE…) never reach the stream: appenders get XADD only.
  if (a.logStream === 'append') parts.push(`(%W~${LOG_STREAM} +xadd)`);
  else parts.push(`(~${LOG_STREAM} ${LOG_READ_COMMANDS.map((c) => `+${c}`).join(' ')})`);
  const channels = a.subscribe === 'all' ? [`${EVENT_CHANNEL_PREFIX}*`] : [...new Set([...a.publish, ...a.subscribe])].map(eventChannel);
  for (const c of channels) parts.push(`&${c}`);
  if (a.publish.length) parts.push('+publish');
  if (a.subscribe === 'all') parts.push('+psubscribe', '+punsubscribe');
  else if (a.subscribe.length) parts.push('+subscribe', '+unsubscribe');
  return [...new Set(parts)].join(' ');
}
