/**
 * The Postgres conversation store, against a real database. Runs only when AGENT_TEST_DATABASE_URL is set (a throwaway
 * database: it creates schema "agent_test" and drops it after).
 */
import postgres from 'postgres';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { createLogger, migrate } from '@app/service-kit';
import { connect, PgConversationStore, type StoredTurn } from '../src/store.ts';

const url = process.env.AGENT_TEST_DATABASE_URL;
const SCHEMA = 'agent_test';

describe.skipIf(!url)('agent: the Postgres conversation store', () => {
  const admin = url ? postgres(url, { max: 1, onnotice: () => {} }) : null;
  const sql = url ? connect(url, SCHEMA) : null;
  afterAll(async () => {
    await sql?.end();
    await admin?.unsafe(`drop schema if exists ${SCHEMA} cascade`);
    await admin?.end();
  });

  it('migrates, keeps turns in order with chips and templates, and returns the last N', async () => {
    await admin!.unsafe(`drop schema if exists ${SCHEMA} cascade; create schema ${SCHEMA}`);
    const applied = await migrate({ databaseUrl: url!, schema: SCHEMA, dir: fileURLToPath(new URL('../migrations', import.meta.url)), log: createLogger('agent', 'silent') });
    expect(applied).toEqual(['0001_init.sql', '0002_conversations.sql']);
    const store = new PgConversationStore(sql!);
    await store.create({ conversation_id: 'cnv_pgtest0001', account_id: 'acc_pgtest0001', widget_id: null });
    expect(await store.get('cnv_pgtest0001')).toEqual({ conversation_id: 'cnv_pgtest0001', account_id: 'acc_pgtest0001', widget_id: null });
    expect(await store.get('cnv_nosuchconv01')).toBeNull();
    const turn = (i: number, role: 'user' | 'agent'): StoredTurn => ({
      turn_id: `trn_pgtest${String(i).padStart(4, '0')}`,
      role,
      text: role === 'agent' ? 'The market says 61%.' : `message ${i}`,
      template: role === 'agent' ? 'The market says {n1}.' : null,
      chips: role === 'agent' ? [{ tool: 'set_look', args: { hue: 32 }, status: 'applied', proposal_id: null, label: 'set_look · hue 32°' }] : [],
      verdict_id: role === 'agent' ? 'vrd_pgtest0001' : null,
      at: new Date(Date.UTC(2026, 10, 7, 12, 0, i)).toISOString(),
    });
    for (let i = 0; i < 6; i++) await store.append('cnv_pgtest0001', turn(i, i % 2 ? 'agent' : 'user'));
    const all = await store.turns('cnv_pgtest0001');
    expect(all.map((t) => t.turn_id)).toEqual([0, 1, 2, 3, 4, 5].map((i) => `trn_pgtest${String(i).padStart(4, '0')}`));
    expect(all[1]).toEqual(turn(1, 'agent'));
    expect((await store.turns('cnv_pgtest0001', 2)).map((t) => t.turn_id)).toEqual(['trn_pgtest0004', 'trn_pgtest0005']);
  });
});
