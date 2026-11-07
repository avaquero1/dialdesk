/**
 * The six function tools (AGENT_TOOLS), validated and run by code. A model's tool call is data: its name must be one of
 * the six, its arguments must pass the tool's schema and the catalog, and it can only touch this account's board.
 * Board changes are collected here and sent to board as one pending proposal per call only after the reply passes the
 * guard, so a blocked reply changes nothing. Every result handed back to the model is written by code.
 */
import {
  AGENT_TOOLS,
  BOARD,
  LookPatch,
  MARKETS,
  displayEntry,
  type AgentToolName,
  type DisplayType,
  type ToolChip,
  type WidgetDraft,
} from '@app/contracts';
import { CallError, type Call } from '@app/service-kit';
import { digitsIn, type Slots } from './slots.ts';

/** What the model knows about one widget on the board: its spec, never its result text. */
export interface BoardWidget {
  widget_id: string;
  kind: 'display' | 'app' | 'folder';
  type: DisplayType | null;
  size: string | null;
  title: string;
  market_ids: string[];
  /** Receipt ids and ops of the widget's current numbers (no values). */
  receipts: { receipt_id: string; op: string }[];
}

export type ProposalChange =
  | { op: 'add'; widget: WidgetDraft }
  | { op: 'tune'; widget_id: string; brief?: string; size?: 'S' | 'M' | 'L' | 'XL'; user_probability?: number; threshold_pts?: number }
  | { op: 'remove'; widget_id: string };

export interface TurnState {
  account_id: string;
  /** Set in a widget's Tune chat: only this widget may be tuned or removed. */
  widget_id: string | null;
  board: BoardWidget[];
  /** Every message the user wrote in this conversation, this one last. Their numbers are theirs to give. */
  userTexts: string[];
  slots: Slots;
  chips: ToolChip[];
  /** Changes waiting for the guard, by chip index. */
  pending: Map<number, ProposalChange[]>;
  /** Texts the model wrote that the user will see besides the reply (titles, briefs): the guard reads them too. */
  shown: string[];
  /** Numbers in settings the model chose this turn (a hue, a threshold): the reply may repeat them. */
  settingDigits: Set<string>;
  /** Calls already run this turn (name + arguments): a repeat is answered without running it again. */
  seen: Set<string>;
  calls: number;
  refused: number;
}

export interface ToolDeps {
  board: Call;
  markets: Call;
}

export const MAX_TOOL_CALLS = 8;

type Outcome = { ok: true; result: Record<string, unknown> } | { ok: false; reason: string };
const refuse = (reason: string): Outcome => ({ ok: false, reason });

const issue = (e: { issues: { path: PropertyKey[]; message: string }[] }) => {
  const i = e.issues[0];
  return i ? `${i.path.map(String).join('.') || 'arguments'}: ${i.message}` : 'invalid arguments';
};

const cut = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A probability the user wrote themselves ("70%", "0.7"). EV never takes a model's estimate (F8). */
export function isUsersNumber(p: number, userTexts: string[]): boolean {
  for (const d of digitsIn(userTexts)) {
    const n = Number(d.replace(',', '.'));
    if (Math.abs(n - p * 100) < 0.05 || (n <= 1 && Math.abs(n - p) < 0.0005)) return true;
  }
  return false;
}

/** The catalog's rules for a display, as board applies them on propose. Returns a reason or null. */
export function checkDraft(d: WidgetDraft, userTexts: string[]): string | null {
  const e = displayEntry(d.type);
  if (d.size && !e.sizes.includes(d.size)) return `${d.type} has no size ${d.size}`;
  const extra = Object.keys(d.params).filter((k) => !(e.params as string[]).includes(k));
  if (extra.length) return `${d.type} takes no ${extra.join(', ')}`;
  if (e.needs_markets && d.market_ids.length === 0) return `${d.type} needs a market`;
  if (new Set(d.market_ids).size !== d.market_ids.length) return 'a market is listed twice';
  if (d.params.user_probability !== undefined && !isUsersNumber(d.params.user_probability, userTexts))
    return "user_probability must be the user's own number";
  return null;
}

function lookLabel(p: LookPatch): string {
  const parts: string[] = [];
  if (p.theme) parts.push(p.theme);
  if (p.mode) parts.push(p.mode);
  if (p.hue === null) parts.push("theme's hue");
  else if (p.hue !== undefined) parts.push(`hue ${p.hue}°`);
  return `set_look · ${parts.join(' · ')}`;
}

/** Runs one tool call. Adds a chip for a known tool; returns what the model reads back. */
export async function runTool(name: string, args: unknown, st: TurnState, deps: ToolDeps): Promise<Record<string, unknown>> {
  st.calls++;
  const key = `${name}:${JSON.stringify(args ?? {})}`;
  if (st.seen.has(key)) return { ok: false, refused: 'already done this turn; answer the user now' };
  st.seen.add(key);
  const known = Object.hasOwn(AGENT_TOOLS, name);
  let out: Outcome;
  let chip: Omit<ToolChip, 'status' | 'proposal_id'> | null = null;
  let change: ProposalChange[] | null = null;
  if (!known) out = refuse(`no tool named ${cut(name, 40)}`);
  else if (st.calls > MAX_TOOL_CALLS) out = refuse(`at most ${MAX_TOOL_CALLS} tool calls a turn`);
  else {
    const tool = name as AgentToolName;
    const parsed = AGENT_TOOLS[tool].safeParse(args ?? {});
    const safeArgs = parsed.success ? (parsed.data as Record<string, unknown>) : {};
    chip = { tool, args: safeArgs, label: tool };
    if (!parsed.success) out = refuse(issue(parsed.error));
    else ({ out, chip, change } = await run(tool, safeArgs, st, deps, chip));
  }
  if (!out.ok) st.refused++;
  if (chip) {
    const i = st.chips.push({ ...chip, label: cut(chip.label), status: out.ok ? (change ? 'proposed' : 'applied') : 'refused', proposal_id: null }) - 1;
    if (out.ok && change) st.pending.set(i, change);
  }
  return out.ok ? { ok: true, ...out.result } : { ok: false, refused: out.reason };
}

type Ran = { out: Outcome; chip: Omit<ToolChip, 'status' | 'proposal_id'>; change: ProposalChange[] | null };

async function run(tool: AgentToolName, a: Record<string, any>, st: TurnState, deps: ToolDeps, chip: Ran['chip']): Promise<Ran> {
  const done = (out: Outcome, label = chip.label, change: ProposalChange[] | null = null): Ran => ({ out, chip: { ...chip, label }, change });
  const onBoard = (id: string) => st.board.find((w) => w.widget_id === id);
  const inScope = (id: string) => (st.widget_id && id !== st.widget_id ? 'this Tune chat can only change its own widget' : !onBoard(id) ? 'no such widget on this board' : null);

  switch (tool) {
    case 'propose_widget': {
      const drafts = a.widgets as WidgetDraft[];
      if (st.widget_id) return done(refuse('a Tune chat changes its own widget; add widgets from the main chat'));
      for (const d of drafts) {
        const bad = checkDraft(d, st.userTexts);
        if (bad) return done(refuse(`${cut(d.title, 40)}: ${bad}`));
        for (const market_id of d.market_ids) {
          const known = await deps.markets(MARKETS.get, { params: { market_id } }).then(
            () => true,
            (e) => (e instanceof CallError && e.status === 404 ? false : true),
          );
          if (!known) return done(refuse(`no market ${market_id}`));
        }
      }
      const widgets = drafts.map((d) => ({ ...d, size: d.size ?? displayEntry(d.type).default_size }));
      st.shown.push(...widgets.flatMap((w) => [w.title, w.brief ?? '']));
      return done({ ok: true, result: { proposed: widgets.map((w) => w.title), note: 'pending until the user taps to accept' } }, widgets.map((w) => w.title).join(' · '), widgets.map((widget) => ({ op: 'add', widget })));
    }
    case 'tune_widget': {
      const bad = inScope(a.widget_id);
      if (bad) return done(refuse(bad));
      const w = onBoard(a.widget_id)!;
      if (w.kind !== 'display' || !w.type) return done(refuse('only displays can be tuned'));
      const e = displayEntry(w.type);
      if (a.size && !e.sizes.includes(a.size)) return done(refuse(`${w.type} has no size ${a.size}`));
      if (a.user_probability !== undefined && !(e.params as string[]).includes('user_probability')) return done(refuse(`${w.type} takes no user_probability`));
      if (a.threshold_pts !== undefined && !(e.params as string[]).includes('threshold_pts')) return done(refuse(`${w.type} takes no threshold_pts`));
      if (a.user_probability !== undefined && !isUsersNumber(a.user_probability, st.userTexts)) return done(refuse("user_probability must be the user's own number"));
      const keys = ['brief', 'size', 'user_probability', 'threshold_pts'].filter((k) => a[k] !== undefined);
      if (!keys.length) return done(refuse('nothing to change'));
      if (a.brief) st.shown.push(a.brief);
      if (a.threshold_pts !== undefined) st.settingDigits.add(String(a.threshold_pts));
      return done({ ok: true, result: { widget_id: w.widget_id, changes: keys, note: 'pending until the user taps to accept' } }, `Tune ${w.title}: ${keys.join(', ')}`, [{ op: 'tune', ...(a as { widget_id: string }) }]);
    }
    case 'remove_widget': {
      const bad = inScope(a.widget_id);
      if (bad) return done(refuse(bad));
      return done({ ok: true, result: { widget_id: a.widget_id, note: 'pending until the user taps to accept' } }, `Remove ${onBoard(a.widget_id)!.title}`, [{ op: 'remove', widget_id: a.widget_id }]);
    }
    case 'quote_market': {
      try {
        const m = await deps.markets(MARKETS.get, { params: { market_id: a.market_id } });
        return done({ ok: true, result: st.slots.quote(m) }, `quote · ${a.market_id}`);
      } catch (e) {
        if (e instanceof CallError && e.status === 404) return done(refuse(`no market ${a.market_id}`));
        if (e instanceof CallError && e.status === 503) return done(refuse('the exchange is down and nothing is cached'));
        throw e;
      }
    }
    case 'read_receipt': {
      try {
        const r = await deps.board(BOARD.getReceipt, { params: { receipt_id: a.receipt_id }, query: { account_id: st.account_id } });
        return done({ ok: true, result: st.slots.receipt(r) }, `receipt · ${a.receipt_id}`);
      } catch (e) {
        if (e instanceof CallError && e.status === 404) return done(refuse('no such receipt on this board'));
        throw e;
      }
    }
    case 'set_look': {
      // Parsed by AGENT_TOOLS.set_look already; parsed again here so the look's rules live in one place (LookPatch).
      const p = LookPatch.safeParse(a);
      if (!p.success) return done(refuse(issue(p.error)));
      if (!Object.keys(p.data).length) return done(refuse('nothing to change: give theme, mode or hue'));
      if (typeof p.data.hue === 'number') st.settingDigits.add(String(p.data.hue));
      return done({ ok: true, result: { look: p.data, note: 'the app applies it now' } }, lookLabel(p.data));
    }
  }
}
