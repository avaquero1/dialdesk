/**
 * packages/guard: the check built into agent and runner. Phase 0 skeleton: the word lists and structural checks in
 * code (layer one). The decision model (layer two, through models with role `guard`) comes in Phase 1 and can only
 * make a verdict stricter, never pass something layer one blocked.
 */
import { newId, type Fact, type Verdict, type VerdictReasonCode, type WidgetResult } from '@app/contracts';

export const WORDLIST_VERSION = 'v0';

/** Advice wording (philosophy.md, "Math, not advice"). Matched as whole words, case-insensitive. */
export const ADVICE_WORDS = ['buy', 'sell', 'should', 'lock', 'sure thing', 'bet', 'betting', 'pick', 'tip', 'guaranteed', 'can\'t lose'];

/** Text aimed at the agent rather than the reader. */
export const INSTRUCTION_PATTERNS: RegExp[] = [
  /\bignore (all |your |the )?(previous|prior|above) (instructions|prompts?)\b/i,
  /\b(ai|assistant|agent|model|llm)\s*[:,]/i,
  /\btell (the|your) user\b/i,
  /\byou (must|need to) (now )?(say|tell|recommend|output)\b/i,
  /\bsystem prompt\b/i,
  /\bnew instructions\b/i,
];
export const EXFIL_PATTERNS: RegExp[] = [/\bsend (the |all )?(user'?s? )?(api )?(keys?|passwords?|tokens?|cookies?)\b/i, /\bexfiltrat/i];
/** Things shaped like secrets. */
export const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(sk|pk|rk)_[A-Za-z0-9]{16,}\b/,
  /\bBearer\s+[A-Za-z0-9._-]{20,}/,
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/,
];

const wordRe = (w: string) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');

function verdict(stage: Verdict['stage'], reasons: Verdict['reasons'], bad: 'block' | 'poison'): Verdict {
  return {
    verdict_id: newId('vrd'),
    stage,
    outcome: reasons.length ? bad : 'pass',
    reasons,
    checker: { wordlist_version: WORDLIST_VERSION, model: null },
    at: new Date().toISOString(),
  };
}

function scan(text: string, where: string, out: Verdict['reasons'], checks: [VerdictReasonCode, RegExp[]][]) {
  for (const [code, res] of checks) if (res.some((r) => r.test(text))) out.push({ code, where });
}

/** Step 3: reader output. Any order aimed at the agent => poison (runner kills the live sandbox). */
export function checkExtract(facts: Pick<Fact, 'fact_id' | 'claim' | 'quote'>[]): Verdict {
  const reasons: Verdict['reasons'] = [];
  for (const f of facts) {
    scan(`${f.claim}\n${f.quote}`, f.fact_id, reasons, [
      ['instruction', INSTRUCTION_PATTERNS],
      ['exfil', EXFIL_PATTERNS],
    ]);
  }
  return verdict('extract', reasons, 'poison');
}

/** Step 6: a result before publish. No advice, a source for every claim, a receipt for every slot, no bare digit, no secrets. */
export function checkPublish(result: Pick<WidgetResult, 'summary' | 'facts' | 'receipts' | 'numbers' | 'sources'>): Verdict {
  const reasons: Verdict['reasons'] = [];
  const s = result.summary;
  if (s) {
    if (/[0-9]/.test(s.template.replace(/\{[nq][0-9]{1,2}\}/g, ''))) reasons.push({ code: 'bare_digit', where: 'summary.template' });
    for (const w of ADVICE_WORDS) if (wordRe(w).test(s.template)) reasons.push({ code: 'advice', where: 'summary.template' });
    scan(s.template, 'summary.template', reasons, [['secret', SECRET_PATTERNS]]);
    const receiptIds = new Set(result.receipts.map((r) => r.id));
    const factIds = new Set(result.facts.map((f) => f.fact_id));
    for (const m of s.template.matchAll(/\{([nq][0-9]{1,2})\}/g)) {
      const slot = s.slots[m[1]!];
      if (!slot) reasons.push({ code: 'missing_receipt', where: `summary.slots.${m[1]}` });
      else if (slot.kind === 'number' && !receiptIds.has(slot.receipt_id)) reasons.push({ code: 'missing_receipt', where: `summary.slots.${m[1]}` });
      else if (slot.kind === 'quote' && !factIds.has(slot.fact_id)) reasons.push({ code: 'unsourced_claim', where: `summary.slots.${m[1]}` });
    }
  }
  const sourceIds = new Set(result.sources.map((x) => x.candidate_id));
  for (const f of result.facts) if (!sourceIds.has(f.candidate_id)) reasons.push({ code: 'unsourced_claim', where: f.fact_id });
  for (const n of result.numbers) if (!result.receipts.some((r) => r.id === n.receipt_id)) reasons.push({ code: 'missing_receipt', where: n.id });
  return verdict('publish', reasons, 'block');
}

/** A chat reply. Blocked => the fixed line BLOCKED_CHAT_LINE. */
export function checkChat(text: string): Verdict {
  const reasons: Verdict['reasons'] = [];
  for (const w of ADVICE_WORDS) if (wordRe(w).test(text)) reasons.push({ code: 'advice', where: 'reply' });
  scan(text, 'reply', reasons, [
    ['secret', SECRET_PATTERNS],
    ['instruction', INSTRUCTION_PATTERNS],
  ]);
  return verdict('chat', reasons, 'block');
}
