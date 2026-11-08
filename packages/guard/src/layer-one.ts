/**
 * Layer one: rules in code, no model. It runs first and decides alone when it's sure: any match blocks (or poisons),
 * and layer two is not asked. What passes here goes on to layer two, which can only add reasons.
 */
import { newId, type Fact, type Verdict, type VerdictReasonCode, type WidgetResult } from '@app/contracts';
import { ADVICE_PATTERNS, BARE_NUMBER_PATTERNS, EXFIL_PATTERNS, INSTRUCTION_PATTERNS, SECRET_PATTERNS, SLOT_RE, VOCABULARY_PATTERNS, WORDLIST_VERSION } from './words.ts';

export type Reasons = Verdict['reasons'];
export type Stage = Verdict['stage'];
export type ExtractInput = Pick<Fact, 'fact_id' | 'claim' | 'quote'>[];
export type PublishInput = Pick<WidgetResult, 'summary' | 'facts' | 'receipts' | 'numbers' | 'sources'>;

/** One piece of text for layer two to judge. `id` becomes the reason's `where`. */
export interface Item {
  id: string;
  text: string;
}

/** Codes that mean a source tried to give the agent orders: at the extract stage they poison. */
export const POISON_CODES = new Set<VerdictReasonCode>(['instruction', 'exfil']);

export function outcomeFor(stage: Stage, reasons: Reasons): Verdict['outcome'] {
  if (!reasons.length) return 'pass';
  if (stage === 'extract' && reasons.some((r) => POISON_CODES.has(r.code))) return 'poison';
  return 'block';
}

export function makeVerdict(stage: Stage, reasons: Reasons, model: string | null): Verdict {
  const seen = new Set<string>();
  const unique = reasons.filter((r) => {
    const k = `${r.code} ${r.where}`;
    return seen.has(k) ? false : (seen.add(k), true);
  });
  return {
    verdict_id: newId('vrd'),
    stage,
    outcome: outcomeFor(stage, unique),
    reasons: unique.map((r) => ({ code: r.code, where: r.where.slice(0, 80) })),
    checker: { wordlist_version: WORDLIST_VERSION, model },
    at: new Date().toISOString(),
  };
}

function scan(text: string, where: string, out: Reasons, checks: [VerdictReasonCode, RegExp[]][]) {
  for (const [code, res] of checks) if (res.some((r) => r.test(text))) out.push({ code, where });
}

// ---- extract (flow B step 3) ----

export function extractItems(facts: ExtractInput): Item[] {
  return facts.map((f) => ({ id: f.fact_id, text: f.claim === f.quote ? f.claim : `${f.claim}\n${f.quote}` }));
}

/** The reader's fixed report that a page holds orders for an AI (READER_PROMPT's first fact). */
export const SELF_REPORT_CLAIM = 'The page embeds instructions aimed at AI agents';

export function isSelfReport(fact: Pick<Fact, 'claim'>): boolean {
  return fact.claim.trim().replace(/[.!]+$/, '').toLowerCase() === SELF_REPORT_CLAIM.toLowerCase();
}

export function extractReasons(facts: ExtractInput): Reasons {
  const reasons: Reasons = [];
  for (const it of extractItems(facts))
    scan(it.text, it.id, reasons, [
      ['instruction', INSTRUCTION_PATTERNS],
      ['exfil', EXFIL_PATTERNS],
    ]);
  return reasons;
}

/** Step 3, layer one only. Any order aimed at the agent => poison (runner kills the live sandbox). */
export function checkExtract(facts: ExtractInput): Verdict {
  return makeVerdict('extract', extractReasons(facts), null);
}

// ---- publish (flow B step 6) ----

/** The summary as the reader will see it: quote slots filled, number slots left as "[number]". */
export function renderSummary(result: PublishInput): string | null {
  const s = result.summary;
  if (!s) return null;
  const facts = new Map(result.facts.map((f) => [f.fact_id, f]));
  return s.template.replace(SLOT_RE, (m) => {
    const slot = s.slots[m.slice(1, -1)];
    if (slot?.kind === 'quote') return `"${facts.get(slot.fact_id)?.quote ?? ''}"`;
    return '[number]';
  });
}

export function publishItems(result: PublishInput): Item[] {
  const items: Item[] = [];
  const rendered = renderSummary(result);
  if (rendered) items.push({ id: 'summary', text: rendered });
  for (const f of result.facts) items.push({ id: f.fact_id, text: f.claim });
  return items;
}

export function publishReasons(result: PublishInput): Reasons {
  const reasons: Reasons = [];
  const s = result.summary;
  if (s) {
    // F8: the template carries no number of its own. Strip the slots, then nothing numeric may be left.
    if (BARE_NUMBER_PATTERNS.some((r) => r.test(s.template.replace(SLOT_RE, ' ')))) reasons.push({ code: 'bare_digit', where: 'summary.template' });
    scan(s.template, 'summary.template', reasons, [
      ['advice', [...ADVICE_PATTERNS, ...VOCABULARY_PATTERNS]],
      ['instruction', INSTRUCTION_PATTERNS],
      ['secret', SECRET_PATTERNS],
    ]);
    const receiptIds = new Set(result.receipts.map((r) => r.id));
    const facts = new Map(result.facts.map((f) => [f.fact_id, f]));
    for (const m of s.template.matchAll(SLOT_RE)) {
      const name = m[0].slice(1, -1);
      const slot = s.slots[name];
      const where = `summary.slots.${name}`;
      if (!slot || slot.kind !== (name.startsWith('n') ? 'number' : 'quote')) reasons.push({ code: 'missing_receipt', where });
      else if (slot.kind === 'number' && !receiptIds.has(slot.receipt_id)) reasons.push({ code: 'missing_receipt', where });
      else if (slot.kind === 'quote') {
        const f = facts.get(slot.fact_id);
        // A quote slot puts page words inside our sentence: it gets the advice rules too.
        if (!f) reasons.push({ code: 'unsourced_claim', where });
        else scan(f.quote, where, reasons, [['advice', ADVICE_PATTERNS]]);
      }
    }
  }
  const sourceIds = new Set(result.sources.map((x) => x.candidate_id));
  for (const f of result.facts) if (!sourceIds.has(f.candidate_id)) reasons.push({ code: 'unsourced_claim', where: f.fact_id });
  for (const n of result.numbers) if (!result.receipts.some((r) => r.id === n.receipt_id)) reasons.push({ code: 'missing_receipt', where: n.id });
  for (const src of result.sources) if (!/^https:\/\//i.test(src.url)) reasons.push({ code: 'bad_link', where: src.candidate_id });
  return reasons;
}

/** Step 6, layer one only: no advice, a source for every claim, a receipt for every slot, no bare digit, no secrets. */
export function checkPublish(result: PublishInput): Verdict {
  return makeVerdict('publish', publishReasons(result), null);
}

// ---- chat (flow D) ----

export function chatReasons(text: string): Reasons {
  const reasons: Reasons = [];
  scan(text, 'reply', reasons, [
    ['advice', [...ADVICE_PATTERNS, ...VOCABULARY_PATTERNS]],
    ['secret', SECRET_PATTERNS],
    ['instruction', INSTRUCTION_PATTERNS],
    ['exfil', EXFIL_PATTERNS],
  ]);
  return reasons;
}

/** A chat reply, layer one only. Blocked => send BLOCKED_CHAT_LINE instead (see `chatReplyText`). */
export function checkChat(text: string): Verdict {
  return makeVerdict('chat', chatReasons(text), null);
}
