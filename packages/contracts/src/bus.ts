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
  /** board -> runner: one widget run. */
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
  [QUEUES.widgetRuns]: { schema: WidgetRunJob, producers: ['board'], consumers: ['runner'] },
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
  board: { queues: [QUEUES.widgetRuns], publish: pubs('board'), subscribe: [], logStream: 'append' },
  agent: { queues: [], publish: [], subscribe: [], logStream: 'append' },
  runner: { queues: [QUEUES.widgetRuns], publish: pubs('runner'), subscribe: [], logStream: 'append' },
  markets: { queues: [], publish: [], subscribe: [], logStream: 'append' },
  connections: { queues: [QUEUES.accountRefresh], publish: [], subscribe: [], logStream: 'append' },
  models: { queues: [], publish: [], subscribe: [], logStream: 'append' },
  audit: { queues: [], publish: [], subscribe: [], logStream: 'read' },
};

/**
 * One ACL line per service (without the password part). Valkey's `&channel` grants both publish and subscribe,
 * so a service gets exactly the channels it publishes or reads. BullMQ needs Lua and its own keys; the queue
 * workers verify the command set against BullMQ in Phase 1.
 */
export function valkeyAclRule(service: z.infer<typeof ServiceName>): string {
  const a = VALKEY_ACL[service];
  const parts: string[] = ['resetkeys', 'resetchannels', '-@all', '+ping', '+hello', '+client|setname', '+info'];
  for (const q of a.queues) parts.push(`~${BULL_PREFIX}:${q}:*`);
  if (a.queues.length) parts.push('+@read', '+@write', '+@scripting', '+@keyspace', '+@list', '+@sortedset', '+@hash', '+@stream', '+@transaction', '+@connection');
  parts.push(a.logStream === 'append' ? `%W~${LOG_STREAM}` : `%RW~${LOG_STREAM}`);
  parts.push(...(a.logStream === 'append' ? ['+xadd'] : ['+xreadgroup', '+xgroup', '+xack', '+xinfo', '+xrange', '+xlen']));
  const channels = a.subscribe === 'all' ? [`${EVENT_CHANNEL_PREFIX}*`] : [...new Set([...a.publish, ...a.subscribe])].map(eventChannel);
  for (const c of channels) parts.push(`&${c}`);
  if (a.publish.length) parts.push('+publish');
  if (a.subscribe === 'all' || a.subscribe.length) parts.push('+subscribe', '+psubscribe', '+unsubscribe', '+punsubscribe');
  return parts.join(' ');
}
