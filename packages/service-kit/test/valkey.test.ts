/**
 * The bus on a real Valkey 8.1 (deploy/compose.dev.yml), each service logged in as its own ACL user from `.env`.
 * Run with `make valkey-test`: it starts its own Compose project, runs this file and removes the project.
 * Without VALKEY_TEST=1 (as in `make check`) the file is skipped.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { LOG_STREAM, QUEUES, widgetRunJobId, type EventName, type ServiceName, type WidgetRunJob } from '@app/contracts';
import { LogStreamReader, NoRetry, RetryLater, ValkeyBus, createQueue, createWorker, logEntry, valkeyClient } from '../src/index.ts';

const on = process.env.VALKEY_TEST === '1';
const port = process.env.VALKEY_TEST_PORT ?? '56379';

function urls(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(join(import.meta.dirname, '../../../.env'), 'utf8').split('\n')) {
    const m = /^([A-Z_]+)_VALKEY_URL=(.+)$/.exec(line);
    if (m) out[m[1]!.toLowerCase().replace(/_/g, '-')] = m[2]!.replace(/:56379$/, `:${port}`);
  }
  return out;
}

const tag = () => randomBytes(6).toString('hex');
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 15_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await wait(50);
  }
}
const run = (widget: string, windowStart = 1_700_000_000): WidgetRunJob => ({
  job_id: widgetRunJobId(widget, 'numbers', windowStart),
  widget_id: widget,
  account_id: 'acc_testtest01',
  kind: 'numbers',
  window_start: windowStart,
  reason: 'schedule',
});

describe.skipIf(!on)('bus on Valkey', () => {
  const url = on ? urls() : {};
  const closers: (() => Promise<unknown>)[] = [];
  const use = <T extends { close: () => Promise<unknown> }>(x: T) => (closers.push(() => x.close()), x);
  /** A raw connection as one service's user, for the allow/deny probes. */
  const as = (s: ServiceName) => {
    const c = valkeyClient(url[s]!, `probe-${s}`, { maxRetriesPerRequest: 0 });
    closers.push(() => c.quit());
    return c;
  };
  afterAll(async () => {
    for (const c of closers.reverse()) await c().catch(() => {});
  });

  it('has a user for each of the 9 services', () => {
    expect(Object.keys(url).sort()).toEqual(['accounts', 'agent', 'audit', 'board', 'connections', 'edge', 'markets', 'models', 'runner']);
  });

  it('publishes an event and edge receives it (PSUBSCRIBE events.*)', async () => {
    const edge = use(new ValkeyBus(url.edge!, 'edge'));
    const board = use(new ValkeyBus(url.board!, 'board'));
    const got: { event: EventName; payload: unknown }[] = [];
    await edge.subscribe('all', (event, payload) => got.push({ event, payload }));
    const payload = { account_id: 'acc_testtest01', at: new Date().toISOString(), widget_id: `wid_${tag()}`, change: 'added' as const };
    await board.emit('widget.updated', payload);
    await until(() => got.length > 0);
    expect(got).toEqual([{ event: 'widget.updated', payload }]);
    // Validated before it leaves: a bad payload never reaches Valkey.
    await expect(board.emit('widget.updated', { ...payload, change: 'exploded' } as never)).rejects.toThrow();
  });

  it('subscribes to named events (SUBSCRIBE) as a service that reads only some', async () => {
    const runner = use(new ValkeyBus(url.runner!, 'runner'));
    // runner publishes run.* but subscribes to nothing: its user has no SUBSCRIBE.
    await expect(runner.subscribe(['run.started'], () => {})).rejects.toThrow(/NOPERM/);
  });

  it('appends to log:actions and audit reads it in the consumer group, then acks', async () => {
    const board = use(new ValkeyBus(url.board!, 'board'));
    const reader = use(new LogStreamReader(url.audit!, 'audit-1'));
    await reader.ensureGroup();
    await reader.ensureGroup(); // BUSYGROUP is fine
    const subject = `wid_${tag()}`;
    await board.log(logEntry('board', 'widget.accepted', { subject_id: subject, outcome: 'ok', sizes: { spec: 812 } }));
    const items = await reader.read({ count: 1000 });
    const mine = items.filter((i) => 'entry' in i && i.entry.subject_id === subject);
    expect(mine).toHaveLength(1);
    // Not acked yet: it is pending for this consumer (what audit re-reads after a restart).
    expect((await reader.read({ pending: true, count: 1000 })).map((i) => i.id)).toContain(mine[0]!.id);
    await reader.ack(items.map((i) => i.id));
    expect(await reader.read({ pending: true })).toEqual([]);
    // A malformed entry comes back as invalid, not as a crash.
    await as('board').xadd(LOG_STREAM, '*', 'entry', '{"nope":1}');
    const bad = await reader.read({ blockMs: 1000 });
    expect(bad.some((i) => 'invalid' in i)).toBe(true);
    await reader.ack(bad.map((i) => i.id));
  });

  it("claims a dead consumer's unacked entries (XAUTOCLAIM) and reports the oldest pending id", async () => {
    const board = use(new ValkeyBus(url.board!, 'board'));
    const dead = use(new LogStreamReader(url.audit!, `audit-dead-${tag()}`));
    const alive = use(new LogStreamReader(url.audit!, `audit-alive-${tag()}`));
    await alive.ensureGroup();
    await alive.ack((await alive.read({ count: 10_000 })).map((i) => i.id)); // start from a clean group
    const subject = `wid_${tag()}`;
    await board.log(logEntry('board', 'widget.accepted', { subject_id: subject, outcome: 'ok' }));
    const taken = (await dead.read({ count: 1000 })).filter((i) => 'entry' in i && i.entry.subject_id === subject);
    expect(taken).toHaveLength(1);
    expect(await alive.oldestPending()).toBe(taken[0]!.id);
    // Not idle long enough yet: nothing moves.
    expect((await alive.claimStale(60_000)).items).toEqual([]);
    await wait(300);
    const { items } = await alive.claimStale(200);
    expect(items.map((i) => i.id)).toEqual([taken[0]!.id]);
    expect((await alive.read({ pending: true })).map((i) => i.id)).toEqual([taken[0]!.id]);
    expect(await dead.read({ pending: true })).toEqual([]);
    await alive.ack([taken[0]!.id]);
    expect(await alive.oldestPending()).toBeNull();
  });

  it('enqueues on widget-runs (board) and runner consumes: dedupe, retry, no retry on poison, busy, timeout', async () => {
    const t = tag();
    const ids = { ok: `wid_ok${t}`, retry: `wid_re${t}`, poison: `wid_po${t}`, busy: `wid_bu${t}`, slow: `wid_sl${t}` };
    const fast = { backoff: { type: 'fixed' as const, delay: 200 } };
    const q = use(createQueue(QUEUES.widgetRuns, url.board!, 'board', fast));
    const seen: string[] = [];
    const errors: string[] = [];
    const w = use(
      createWorker(
        QUEUES.widgetRuns,
        url.runner!,
        'runner',
        async (job, ctx) => {
          seen.push(`${job.widget_id}#${ctx.attempt}`);
          if (job.widget_id === ids.retry && ctx.attempt === 1) throw new Error('sandbox infra error');
          if (job.widget_id === ids.poison) throw new NoRetry('poison');
          if (job.widget_id === ids.busy && seen.filter((s) => s.startsWith(ids.busy)).length < 3) throw new RetryLater(100);
          if (job.widget_id === ids.slow) await new Promise((_, reject) => ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason)));
        },
        { rules: { timeoutMs: 1_000 } },
      ),
    );
    const failed: Record<string, string> = {};
    w.worker.on('failed', (job, err) => (failed[job!.data.widget_id] = err.message));
    w.worker.on('error', (e) => errors.push(e.message));
    const completed = new Set<string>();
    w.worker.on('completed', (job) => completed.add(job.data.widget_id));

    expect(await q.enqueue(run(ids.ok))).toBe(`${ids.ok}:numbers:1700000000`);
    await q.enqueue(run(ids.ok)); // same window: collapses into the first
    for (const id of [ids.retry, ids.poison, ids.busy, ids.slow]) await q.enqueue(run(id));
    await expect(q.enqueue({ ...run(ids.ok), job_id: `${ids.ok}:numbers:1` })).rejects.toThrow(/job_id must be/);

    await until(() => seen.includes(`${ids.retry}#2`) && ids.poison in failed && ids.slow in failed && seen.filter((s) => s.startsWith(ids.busy)).length === 3);
    await wait(300);
    expect(seen.filter((s) => s.startsWith(ids.ok))).toEqual([`${ids.ok}#1`]);
    expect(seen.filter((s) => s.startsWith(ids.retry))).toEqual([`${ids.retry}#1`, `${ids.retry}#2`]);
    expect(seen.filter((s) => s.startsWith(ids.poison))).toEqual([`${ids.poison}#1`]);
    expect(seen.filter((s) => s.startsWith(ids.busy))).toEqual([`${ids.busy}#1`, `${ids.busy}#1`, `${ids.busy}#1`]); // busy spends no attempt
    expect(failed[ids.poison]).toBe('poison');
    expect(failed[ids.slow]).toMatch(/ran past 1000 ms/);
    expect(seen.filter((s) => s.startsWith(ids.slow))).toEqual([`${ids.slow}#1`]); // a timeout isn't retried
    expect([...completed].sort()).toEqual([ids.busy, ids.ok, ids.retry].sort());
    expect(errors).toEqual([]); // no NOPERM anywhere in BullMQ's scripts
  });

  it('runs account-refresh for connections', async () => {
    const q = use(createQueue(QUEUES.accountRefresh, url.connections!, 'connections'));
    const got: string[] = [];
    use(createWorker(QUEUES.accountRefresh, url.connections!, 'connections', async (job) => void got.push(job.connection_id)));
    const con = `con_${tag()}`;
    await q.enqueue({ job_id: `refresh-${con}`, connection_id: con, account_id: 'acc_testtest01' });
    await until(() => got.includes(con));
  });

  describe('ACL: each user reaches only its own queues, channels and the stream', () => {
    it("board can't touch account-refresh, runner's channels or another service's keys", async () => {
      const board = as('board');
      await expect(board.call('LPUSH', 'bull:account-refresh:wait', 'x')).rejects.toThrow(/NOPERM/);
      await expect(board.call('SET', 'anything', 'x')).rejects.toThrow(/NOPERM/);
      await expect(board.publish('events.run.poisoned', '{}')).rejects.toThrow(/NOPERM/);
      await expect(board.call('SUBSCRIBE', 'events.widget.updated')).rejects.toThrow(/NOPERM/);
      // Lua runs as the caller: a script can't reach outside the user's keys either.
      await expect(board.call('EVAL', "return redis.call('SET', KEYS[1], 'x')", '1', 'bull:account-refresh:x')).rejects.toThrow(/NOPERM|permission/i);
      await expect(board.call('EVAL', "return redis.call('FLUSHALL')", '0')).rejects.toThrow(/NOPERM|permission/i);
      const q = use(createQueue(QUEUES.accountRefresh, url.board!, 'board'));
      await expect(q.enqueue({ job_id: 'refresh-x', connection_id: 'con_testtest01', account_id: 'acc_testtest01' })).rejects.toThrow(/NOPERM|permission/i);
    });

    it('appenders can only XADD to log:actions: no read, trim, delete or expire', async () => {
      for (const s of ['board', 'runner', 'edge', 'models'] as const) {
        const c = as(s);
        await expect(c.xadd(LOG_STREAM, '*', 'entry', '{}')).resolves.toBeTruthy();
        for (const cmd of [['XRANGE', LOG_STREAM, '-', '+'], ['XTRIM', LOG_STREAM, 'MAXLEN', '0'], ['XDEL', LOG_STREAM, '0-1'], ['DEL', LOG_STREAM], ['PEXPIRE', LOG_STREAM, '1'], ['XREADGROUP', 'GROUP', 'audit', 'x', 'STREAMS', LOG_STREAM, '>']]) {
          await expect(c.call(cmd[0]!, ...cmd.slice(1)), `${s} ${cmd[0]}`).rejects.toThrow(/NOPERM/);
        }
      }
    });

    it('audit reads the stream and nothing else', async () => {
      const audit = as('audit');
      await expect(audit.xlen(LOG_STREAM)).resolves.toBeGreaterThan(0);
      await expect(audit.xadd(LOG_STREAM, '*', 'entry', '{}')).rejects.toThrow(/NOPERM/);
      await expect(audit.call('DEL', LOG_STREAM)).rejects.toThrow(/NOPERM/);
      await expect(audit.call('LLEN', 'bull:widget-runs:wait')).rejects.toThrow(/NOPERM/);
    });

    it('edge subscribes to every event but publishes none; models has no queue', async () => {
      await expect(as('edge').publish('events.widget.updated', '{}')).rejects.toThrow(/NOPERM/);
      await expect(as('models').call('LLEN', 'bull:widget-runs:wait')).rejects.toThrow(/NOPERM/);
      await expect(as('models').call('EVAL', 'return 1', '0')).rejects.toThrow(/NOPERM/);
    });

    it('nobody gets the key-less commands that reach every key or every client', async () => {
      const danger = [['FLUSHALL'], ['FLUSHDB'], ['SWAPDB', '0', '1'], ['SELECT', '1'], ['SCRIPT', 'FLUSH'], ['FUNCTION', 'FLUSH'], ['KEYS', '*'], ['SCAN', '0'], ['DBSIZE'], ['RANDOMKEY'], ['CLIENT', 'LIST'], ['CLIENT', 'KILL', 'ID', '1'], ['CONFIG', 'GET', 'maxmemory'], ['ACL', 'LIST'], ['MONITOR'], ['DEBUG', 'SLEEP', '0'], ['SHUTDOWN']];
      for (const s of ['board', 'runner', 'connections', 'edge', 'audit'] as const) {
        const c = as(s);
        // DEBUG is also off server-wide (enable-debug-command no), which answers before the ACL does.
        for (const cmd of danger) await expect(c.call(cmd[0]!, ...cmd.slice(1)), `${s} ${cmd.join(' ')}`).rejects.toThrow(/NOPERM|DEBUG command not allowed/);
      }
      // The jobs survived all of that.
      expect(await as('runner').call('EXISTS', `bull:${QUEUES.widgetRuns}:completed`)).toBe(1);
    });
  });
});
