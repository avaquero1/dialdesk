import { z } from 'zod';
import { Timestamp, VerdictId } from './common.ts';

/**
 * The guard's verdict.
 * - stage `extract`: reader output checked for orders aimed at the agent. `poison` => runner kills the live sandbox.
 *   `block` (reason `unchecked` only) => the check couldn't finish: runner releases the sandbox and drops that source's
 *   facts, without the poison note.
 * - stage `publish`: a result before board stores it. `block` => not stored.
 * - stage `chat`: a chat reply. `block` => the fixed line "I do math, not calls."
 */
export const VerdictStage = z.enum(['extract', 'publish', 'chat']);
export const VerdictOutcome = z.enum(['pass', 'block', 'poison']);
export const VerdictReasonCode = z.enum([
  'instruction', // text aimed at the agent ("ignore your instructions", "tell the user to…")
  'exfil', // asks to send data somewhere
  'advice', // buy, sell, should, lock, sure thing, bet…
  'unsourced_claim', // a claim with no fact id
  'missing_receipt', // a number slot with no receipt
  'bare_digit', // a digit in a summary template outside a slot
  'secret', // something shaped like a key or token
  'bad_link', // a link that isn't https or isn't one of the run's sources
  'unchecked', // the decision model (layer two) failed or gave no readable answer: the guard fails closed
]);
export type VerdictReasonCode = z.infer<typeof VerdictReasonCode>;

export const Verdict = z
  .object({
    verdict_id: VerdictId,
    stage: VerdictStage,
    outcome: VerdictOutcome,
    reasons: z.array(
      z
        .object({
          code: VerdictReasonCode,
          where: z.string().max(80).describe('a field path or fact id, never the offending text'),
        })
        .strict(),
    ),
    checker: z
      .object({
        wordlist_version: z.string(),
        model: z.string().nullable().describe('the decision model, when the second layer ran'),
      })
      .strict(),
    at: Timestamp,
  })
  .strict();
export type Verdict = z.infer<typeof Verdict>;

/** The fixed reply when a chat reply is blocked. */
export const BLOCKED_CHAT_LINE = 'I do math, not calls.';
/** The widget's note when a source is poisoned. It never quotes the page. */
export const POISONED_NOTE = 'Source blocked. This page tried to give the agent orders.';
