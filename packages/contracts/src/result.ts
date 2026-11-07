import { z } from 'zod';
import {
  AuditRowId,
  CandidateId,
  Domain,
  FactId,
  ReceiptId,
  ResultId,
  RunId,
  SourceUrl,
  Timestamp,
  VerdictId,
  WidgetId,
} from './common.ts';
import { EngineNumber, EngineReceipt } from './rust.ts';

export const RunKind = z.enum(['numbers', 'research']);
export type RunKind = z.infer<typeof RunKind>;

/** A fact from the reader model: a short claim and the quote it rests on. */
export const Fact = z
  .object({
    fact_id: FactId,
    candidate_id: CandidateId,
    claim: z.string().max(300),
    quote: z.string().max(300),
  })
  .strict();
export type Fact = z.infer<typeof Fact>;

/** A slot in a summary template: `{n1}` is an engine number, `{q1}` a fact's quote. */
export const SlotName = z.string().regex(/^[nq][0-9]{1,2}$/);
export const Slot = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('number'),
      number_id: z.string().describe('the engine NumberOut id'),
      receipt_id: ReceiptId,
      format: z.enum(['percent', 'cents', 'points', 'usd', 'odds']),
    })
    .strict(),
  z.object({ kind: z.literal('quote'), fact_id: FactId }).strict(),
]);

/**
 * Words with blanks. The template holds no digits; every `{slot}` in it has an entry in `slots`
 * (the guard checks both).
 */
export const SlotSummary = z
  .object({
    template: z.string().max(600),
    slots: z.record(SlotName, Slot),
  })
  .strict();
export type SlotSummary = z.infer<typeof SlotSummary>;

export const SandboxState = z.enum(['created', 'held', 'released', 'killed', 'destroyed']);

/** One step of a run, shown live from run.step and stored with the result. */
export const RunStepName = z.enum(['sources', 'plan', 'read', 'extract', 'math', 'summary', 'guard', 'publish']);
export const RunTraceStep = z
  .object({
    run_id: RunId,
    widget_id: WidgetId,
    seq: z.number().int().min(0),
    step: RunStepName,
    status: z.enum(['started', 'ok', 'failed', 'poisoned', 'skipped']),
    at: Timestamp,
    duration_ms: z.number().int().min(0).nullable(),
    sandbox: z.object({ sandbox_id: z.string(), state: SandboxState }).strict().nullable(),
    source: z
      .object({
        candidate_id: CandidateId,
        url: SourceUrl,
        domain: Domain,
        screenshot_key: z.string().nullable().describe('Object Storage key, shown as an image labelled "external page"'),
      })
      .strict()
      .nullable(),
    proxy: z.object({ allowed: z.number().int().min(0), refused: z.number().int().min(0) }).strict().nullable(),
    verdict_id: VerdictId.nullable(),
    receipt_ids: z.array(ReceiptId),
    audit_row_id: AuditRowId.nullable(),
    note: z.string().max(200).nullable(),
  })
  .strict();
export type RunTraceStep = z.infer<typeof RunTraceStep>;

export const ResultSource = z
  .object({
    candidate_id: CandidateId,
    url: SourceUrl,
    domain: Domain,
    outlet: z.string().max(80).nullable(),
    published_at: Timestamp.nullable(),
    status: z.enum(['read', 'blocked', 'refused', 'failed']),
  })
  .strict();

export const BlockedItem = z
  .object({
    candidate_id: CandidateId,
    domain: Domain,
    reason: z.literal('poison'),
    note: z.string().describe('POISONED_NOTE, never a quote of the page'),
    killed_at: Timestamp,
    audit_row_id: AuditRowId.nullable(),
  })
  .strict();

/** A widget's result. board stores it only with a passing publish verdict. */
export const WidgetResult = z
  .object({
    result_id: ResultId,
    widget_id: WidgetId,
    run_id: RunId,
    kind: RunKind,
    created_at: Timestamp,
    as_of: Timestamp.describe('the market data time'),
    stale: z.boolean().describe('true when an exchange was down and the last cached price was used'),
    numbers: z.array(EngineNumber),
    receipts: z.array(EngineReceipt),
    facts: z.array(Fact),
    summary: SlotSummary.nullable().describe('null in a numbers run and in phase one of publish'),
    sources: z.array(ResultSource),
    blocked: z.array(BlockedItem),
    verdict_id: VerdictId,
  })
  .strict();
export type WidgetResult = z.infer<typeof WidgetResult>;
