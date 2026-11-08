/**
 * Conversation history: Postgres (schema `agent`, role svc_agent) in real mode, memory in tests and without a database.
 * Every read is scoped by account_id.
 */
import type { ChatTurn, ToolChip } from '@app/contracts';
import postgres from 'postgres';

/** A stored turn: the contract's ChatTurn plus, for agent turns, the model's template (slots unfilled). */
export type StoredTurn = ChatTurn & { template: string | null };

export interface Conversation {
  conversation_id: string;
  account_id: string;
  widget_id: string | null;
}

export interface ConversationStore {
  create(c: Conversation): Promise<void>;
  /** null when the conversation doesn't exist. */
  get(conversation_id: string): Promise<Conversation | null>;
  append(conversation_id: string, turn: StoredTurn): Promise<void>;
  /** The last `limit` turns, oldest first. */
  turns(conversation_id: string, limit?: number): Promise<StoredTurn[]>;
  /** Every account with a conversation (the orphan sweep). */
  accountIds(): Promise<string[]>;
  /** Deletes the account's conversations and their turns; answers how many conversations. */
  forget(account_id: string): Promise<number>;
}

export class MemoryConversationStore implements ConversationStore {
  private convs = new Map<string, Conversation & { turns: StoredTurn[] }>();
  async create(c: Conversation) {
    this.convs.set(c.conversation_id, { ...c, turns: [] });
  }
  async get(id: string) {
    const c = this.convs.get(id);
    return c ? { conversation_id: c.conversation_id, account_id: c.account_id, widget_id: c.widget_id } : null;
  }
  async append(id: string, turn: StoredTurn) {
    this.convs.get(id)?.turns.push(turn);
  }
  async turns(id: string, limit = 1000) {
    return (this.convs.get(id)?.turns ?? []).slice(-limit);
  }
  async accountIds() {
    return [...new Set([...this.convs.values()].map((c) => c.account_id))];
  }
  async forget(account_id: string) {
    let n = 0;
    for (const [id, c] of this.convs) if (c.account_id === account_id && this.convs.delete(id)) n++;
    return n;
  }
}

type TurnRow = { turn_id: string; role: ChatTurn['role']; text: string; template: string | null; chips: ToolChip[]; picks: string[] | null; verdict_id: string | null; at: Date };

/** svc_agent's pool. The role is limited to 5 connections; migrations use one at start. */
export const connect = (url: string, schema = 'agent') =>
  postgres(url, { max: 4, onnotice: () => {}, connection: { search_path: schema, application_name: 'agent' } });

export class PgConversationStore implements ConversationStore {
  constructor(private sql: postgres.Sql) {}
  async create(c: Conversation) {
    await this.sql`insert into conversations (conversation_id, account_id, widget_id) values (${c.conversation_id}, ${c.account_id}, ${c.widget_id})`;
  }
  async get(id: string) {
    const [r] = await this.sql<Conversation[]>`select conversation_id, account_id, widget_id from conversations where conversation_id = ${id}`;
    return r ?? null;
  }
  async append(id: string, t: StoredTurn) {
    await this.sql`
      insert into turns (turn_id, conversation_id, role, text, template, chips, picks, verdict_id, at)
      values (${t.turn_id}, ${id}, ${t.role}, ${t.text}, ${t.template}, ${this.sql.json(t.chips as never)}, ${t.picks ? this.sql.json(t.picks) : null}, ${t.verdict_id}, ${t.at})`;
  }
  async turns(id: string, limit = 1000) {
    const rows = await this.sql<TurnRow[]>`
      select * from (
        select seq, turn_id, role, text, template, chips, picks, verdict_id, at from turns
        where conversation_id = ${id} order by seq desc limit ${limit}
      ) t order by seq`;
    return rows.map((r) => ({
      turn_id: r.turn_id,
      role: r.role,
      text: r.text,
      template: r.template,
      chips: r.chips,
      ...(r.picks && { picks: r.picks }),
      verdict_id: r.verdict_id,
      at: r.at.toISOString(),
    }));
  }
  async accountIds() {
    return (await this.sql<{ account_id: string }[]>`select distinct account_id from conversations`).map((r) => r.account_id);
  }
  /** Turns cascade (migrations/0002_conversations.sql). */
  async forget(account_id: string) {
    return (await this.sql`delete from conversations where account_id = ${account_id} returning conversation_id`).length;
  }
}
