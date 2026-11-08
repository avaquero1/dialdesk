/**
 * The reply as the user reads it, put together by code from what the model wrote:
 * - `withSaid`: text the model wrote beside a tool call is kept, before its last reply. Every model in the A1.2.1
 *   bake-off wrote "I do math, not calls." beside its quote_market call and then left it out of the last reply.
 * - `fixWidgetCount`: a sentence that claims more proposed widgets than the chips show is replaced by one
 *   code writes from the chips (the bake-off saw "I proposed two widgets" with one chip).
 */
import type { ToolChip } from '@app/contracts';

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9{}]+/g, ' ').trim();

/** The earlier steps' text, then the last reply; a line the last reply already holds isn't repeated. */
export function withSaid(said: string[], last: string): string {
  const seen = squash(last);
  const keep: string[] = [];
  for (const s of said.map((x) => x.trim()).filter(Boolean)) {
    const k = squash(s);
    if (!k || seen.includes(k) || keep.some((x) => squash(x).includes(k))) continue;
    keep.push(s);
  }
  return [...keep, last].filter(Boolean).join(' ').trim();
}

const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const COUNT: Record<string, number> = { no: 0, zero: 0, a: 1, an: 1, one: 1, single: 1, both: 2, couple: 2, pair: 2, ...Object.fromEntries(WORDS.slice(2).map((w, i) => [w, i + 2])) };
/** What the chat models call a widget (glm-5.3-flash says "tiles"). */
const NOUNS = new Set(['widget', 'widgets', 'tile', 'tiles', 'card', 'cards']);
const CLAIM_VERB = /\b(?:proposed|propose|added|built|made|created|set up|drafted|put together|lined up|queued|here (?:are|is)|here's|these are|this is|i've got|ready)\b/i;
/** How many widgets the chips propose: propose_widget chips that weren't refused, by their widget count. */
export function proposedCount(chips: ToolChip[]): number {
  return chips.filter((c) => c.tool === 'propose_widget' && c.status !== 'refused').reduce((n, c) => n + (Array.isArray((c.args as { widgets?: unknown[] }).widgets) ? (c.args as { widgets: unknown[] }).widgets.length : 1), 0);
}

/** The count a sentence claims for its proposal, or null when it claims none (an offer, a question, a plain mention). */
export function claimedCount(sentence: string): number | null {
  if (!CLAIM_VERB.test(sentence) || /\?\s*$/.test(sentence) || /\b(?:want|like|could|can|should i|shall i|if you)\b/i.test(sentence)) return null;
  let claim: number | null = null;
  // Each "widget(s)" (or tile, card), and the count among the three words before it: "two new widgets", "a couple of widgets".
  const words = sentence.toLowerCase().match(/\{n\d+\}|[a-z0-9']+/g) ?? [];
  words.forEach((w, i) => {
    if (!NOUNS.has(w)) return;
    const before = words.slice(Math.max(0, i - 3), i).reverse();
    // A digit is never the count: it is part of a name ("an NFL Week 10 events widget", seen on the real model).
    const word = before.find((x) => Object.hasOwn(COUNT, x));
    const n = word === undefined ? (w.endsWith('s') ? 2 : null) : COUNT[word]!;
    if (n !== null) claim = Math.max(claim ?? 0, n);
  });
  return claim;
}

const truth = (n: number) => (n === 0 ? 'No widget was proposed this time.' : n === 1 ? 'I proposed one widget: tap it to add it.' : `I proposed ${WORDS[n] ?? 'several'} widgets: tap each one to add it.`);

/**
 * Replaces each sentence that claims more widgets than the chips propose. A plural "widgets" claims two, so "here
 * are your widgets" beside one chip is caught too. Returns the text and how many sentences were replaced.
 */
export function fixWidgetCount(text: string, chips: ToolChip[]): { text: string; fixed: number } {
  const n = proposedCount(chips);
  let fixed = 0;
  let wrote = false;
  const out = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => {
      const claim = claimedCount(s);
      // Only a claim past the chips is caught: "here's a widget for the Bills" beside two chips is true.
      if (claim === null || claim <= n) return s;
      fixed++;
      if (wrote) return '';
      wrote = true;
      return truth(n);
    })
    .filter(Boolean)
    .join(' ');
  return { text: out, fixed };
}
