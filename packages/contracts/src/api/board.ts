import { z } from 'zod';
import { AccountId, Domain, Ok, ProposalId, ReceiptId, ResultId, Timestamp, WidgetId } from '../common.ts';
import { DisplaySize } from '../catalog.ts';
import { api } from '../endpoint.ts';
import { RunTraceStep, WidgetResult } from '../result.ts';
import { EngineReceipt } from '../rust.ts';
import { Verdict } from '../verdict.ts';
import { Place, WidgetDraft, WidgetProfile, WidgetSpec, WidgetState } from '../widget.ts';

export const Widget = z
  .object({
    spec: WidgetSpec,
    profile: WidgetProfile.nullable().describe('null for apps and folders'),
    state: WidgetState,
    result: WidgetResult.nullable(),
    previous: WidgetResult.nullable().describe('for "since you last looked"'),
    updated_at: Timestamp,
  })
  .strict();
export type Widget = z.infer<typeof Widget>;

export const ProposalChange = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add'), widget: WidgetDraft }).strict(),
  z
    .object({
      op: z.literal('tune'),
      widget_id: WidgetId,
      brief: z.string().max(500).optional(),
      size: DisplaySize.optional(),
      user_probability: z.number().min(0).max(1).optional(),
      threshold_pts: z.number().min(1).max(50).optional(),
    })
    .strict(),
  z.object({ op: z.literal('remove'), widget_id: WidgetId }).strict(),
]);

export const Proposal = z
  .object({
    proposal_id: ProposalId,
    account_id: AccountId,
    status: z.enum(['pending', 'accepted', 'rejected']),
    changes: z.array(ProposalChange).min(1).max(6),
    created_at: Timestamp,
  })
  .strict();
export type Proposal = z.infer<typeof Proposal>;

export const Board = z
  .object({
    account_id: AccountId,
    widgets: z.array(Widget),
    pending: z.array(Proposal),
  })
  .strict();
export type Board = z.infer<typeof Board>;

const acc = z.object({ account_id: AccountId });
const wid = z.object({ widget_id: WidgetId });
const accQuery = z.object({ account_id: AccountId });

export const BOARD = api('board', {
  getBoard: {
    method: 'GET',
    path: '/boards/:account_id',
    callers: ['edge', 'agent'],
    params: acc,
    response: Board,
    errors: [404],
    summary: "An account's whole board.",
  },
  createDefaults: {
    method: 'POST',
    path: '/boards/:account_id',
    callers: ['edge'],
    params: acc,
    body: z.object({ category: z.literal('sports') }).strict(),
    response: Board,
    status: 201,
    errors: [409],
    summary: 'Create the prescribed default board (after sign-up). Enqueues a numbers run for each display.',
  },
  setLayout: {
    method: 'PUT',
    path: '/boards/:account_id/layout',
    callers: ['edge'],
    params: acc,
    body: z.object({ places: z.array(z.object({ widget_id: WidgetId, place: Place }).strict()).max(200) }).strict(),
    response: Board,
    errors: [400, 404],
    summary: "The user's drags, drops and folders.",
  },
  propose: {
    method: 'POST',
    path: '/boards/:account_id/proposals',
    callers: ['agent'],
    params: acc,
    body: z.object({ changes: z.array(ProposalChange).min(1).max(6) }).strict(),
    response: Proposal,
    status: 201,
    errors: [400, 404],
    summary: "The agent's proposal, stored pending. Each add is validated against the widget catalog.",
  },
  accept: {
    method: 'POST',
    path: '/proposals/:proposal_id/accept',
    callers: ['edge'],
    params: z.object({ proposal_id: ProposalId }),
    body: acc.strict(),
    response: z.object({ proposal: Proposal, widgets: z.array(Widget) }).strict(),
    errors: [404, 409],
    summary: "The user's click. Saves the widgets and enqueues a numbers run, then a research run.",
  },
  reject: {
    method: 'POST',
    path: '/proposals/:proposal_id/reject',
    callers: ['edge'],
    params: z.object({ proposal_id: ProposalId }),
    body: acc.strict(),
    response: Proposal,
    errors: [404, 409],
    summary: 'The user says no.',
  },
  getWidget: {
    method: 'GET',
    path: '/widgets/:widget_id',
    callers: ['edge', 'agent', 'runner'],
    params: wid,
    query: accQuery,
    response: Widget,
    errors: [404],
    summary: 'One widget. runner reloads the spec here instead of trusting the job payload.',
  },
  resize: {
    method: 'PATCH',
    path: '/widgets/:widget_id/size',
    callers: ['edge'],
    params: wid,
    body: z.object({ account_id: AccountId, size: DisplaySize }).strict(),
    response: Widget,
    errors: [400, 404],
    summary: 'Size S, M, L (XL on desktop), checked against the catalog.',
  },
  clear: {
    method: 'POST',
    path: '/widgets/:widget_id/clear',
    callers: ['edge'],
    params: wid,
    body: acc.strict(),
    response: Widget,
    errors: [404],
    summary: "Clear all: back to the type's defaults (brief, added sources and feedback cleared).",
  },
  remove: {
    method: 'DELETE',
    path: '/widgets/:widget_id',
    callers: ['edge'],
    params: wid,
    query: accQuery,
    response: Ok,
    errors: [404],
    summary: 'Remove from board.',
  },
  refresh: {
    method: 'POST',
    path: '/widgets/:widget_id/refresh',
    callers: ['edge'],
    params: wid,
    body: acc.strict(),
    response: z.object({ job_id: z.string() }).strict(),
    status: 202,
    errors: [404, 429],
    summary: 'Refresh now: enqueue a run.',
  },
  addSource: {
    method: 'POST',
    path: '/widgets/:widget_id/sources',
    callers: ['edge'],
    params: wid,
    body: z.object({ account_id: AccountId, domain: Domain }).strict(),
    response: Widget,
    errors: [400, 404],
    summary: "The user's click on a suggested source adds its domain to this widget's profile.",
  },
  putResult: {
    method: 'PUT',
    path: '/widgets/:widget_id/result',
    callers: ['runner'],
    params: wid,
    body: z
      .object({
        account_id: AccountId,
        result: WidgetResult,
        verdict: Verdict,
        trace: z.array(RunTraceStep),
        phase: z.enum(['numbers', 'summary']),
      })
      .strict(),
    response: z.object({ result_id: ResultId }).strict(),
    errors: [400, 404, 422],
    summary: 'Store a result. Refused (422) unless the verdict is a passing publish verdict. Emits result.updated.',
  },
  getTrace: {
    method: 'GET',
    path: '/widgets/:widget_id/trace',
    callers: ['edge'],
    params: wid,
    query: accQuery,
    response: z.object({ steps: z.array(RunTraceStep) }).strict(),
    errors: [404],
    summary: 'Sources and receipts: the last run trace.',
  },
  getReceipt: {
    method: 'GET',
    path: '/receipts/:receipt_id',
    callers: ['edge', 'agent'],
    params: z.object({ receipt_id: ReceiptId }),
    query: accQuery,
    response: EngineReceipt,
    errors: [404],
    summary: "A receipt already on this account's board.",
  },
});
