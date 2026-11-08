import { z } from 'zod';
import { AccountId, CandidateId, Cents, ConnectionId, Domain, Exchange, MarketId, Ok, ProposalId, ReceiptId, ResultId, RunId, Timestamp, WidgetId } from '../common.ts';
import { DisplaySize, DisplayType } from '../catalog.ts';
import { api } from '../endpoint.ts';
import { ResultSince, RunTraceStep, WidgetResult } from '../result.ts';
import { EngineReceipt } from '../rust.ts';
import { Verdict } from '../verdict.ts';
import { Place, WidgetDraft, WidgetProfile, WidgetSpec, WidgetState } from '../widget.ts';

/**
 * First paint: a market's cached price from markets, copied when board creates the widget, so a new board isn't empty
 * before its first run. Exchange data shown with its "as of" stamp, not engine math: the first result replaces it.
 */
export const Quote = z
  .object({
    market_id: MarketId,
    exchange: Exchange,
    yes_price_cents: Cents,
    previous_price_cents: Cents.nullable().describe('24 h ago'),
    as_of: Timestamp,
    stale: z.boolean(),
  })
  .strict();
export type Quote = z.infer<typeof Quote>;

/**
 * The strip "since you last looked" (getBoard): the current result's engine moves against the result the owner saw at
 * the previous visit, and how many of its items are new. null when nothing changed or there was no earlier visit.
 */
export const WidgetSince = ResultSince.extend({
  from_at: Timestamp.describe("when that result was made (the owner's previous visit saw it)"),
  new_items: z.number().int().min(0).describe('facts in the current result that the earlier one did not have'),
}).strict();
export type WidgetSince = z.infer<typeof WidgetSince>;

export const Widget = z
  .object({
    spec: WidgetSpec,
    profile: WidgetProfile.nullable().describe('null for apps and folders'),
    state: WidgetState,
    result: WidgetResult.nullable(),
    previous: WidgetResult.nullable().describe('the run before the latest'),
    baseline: WidgetResult.nullable().optional().describe("getWidget: the result the owner saw at the previous visit, what runner's since moves compare with"),
    since: WidgetSince.nullable().optional().describe('getBoard: what changed since the owner\'s previous visit'),
    quotes: z.array(Quote).max(12).optional().describe('first paint: cached prices for the spec\'s markets, until the first result'),
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

/** A screenshot of an external page, PNG, base64. About 2 MB at most. */
const PngBase64 = z.string().max(2_800_000).regex(/^iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/, 'a base64 PNG');
const screenshotParams = z.object({ widget_id: WidgetId, run_id: RunId, candidate_id: CandidateId });

const acc = z.object({ account_id: AccountId });
const wid = z.object({ widget_id: WidgetId });
const accQuery = z.object({ account_id: AccountId });
/** On a refresh answer: true when it joined the run of the same kind already asked for in this minute ("Updated just now"). */
/**
 * One way to add a display by hand (the Add app): a widget draft on this week's games, with the game it follows and its
 * label in plain words ("Jets at Chiefs, Sun 1 PM"). event_key null: the catalog's own draft (no games ahead, markets down
 * or only fixture markets), or a type that follows several games (Tonight, Biggest move) or none (Your account).
 */
export const AddDraft = z
  .object({ event_key: z.string().max(64).nullable(), label: z.string().min(1).max(80), widget: WidgetDraft })
  .strict();
export type AddDraft = z.infer<typeof AddDraft>;

/** A folder's title: 1-60 characters after trimming, plain text (no control characters or markup brackets). */
export const FolderTitle = z
  .string()
  .trim()
  .min(1)
  .max(60)
  // eslint-disable-next-line no-control-regex -- refusing control characters is the point
  .regex(/^[^\u0000-\u001f\u007f<>]*$/, 'plain text');

/** makeFolder's body: the displays to put in a new folder, in order. */
export const FolderBody = z
  .object({
    widget_ids: z.array(WidgetId).min(2).max(24),
    title: FolderTitle.optional(),
    place: z.object({ col: z.number().int().min(0).max(63), row: z.number().int().min(0).max(255) }).strict().optional().describe('a grid place'),
  })
  .strict();

export const Joined = z.boolean().optional().describe('true: joined the run already asked for in this minute');

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
  addDrafts: {
    method: 'GET',
    path: '/drafts/:type',
    callers: ['edge'],
    params: z.object({ type: DisplayType }),
    response: z.object({ drafts: z.array(AddDraft).min(1).max(12) }).strict(),
    errors: [400],
    summary:
      "The Add app's drafts for a display type, the way the first board picks this week's games: the default first (the most traded game, tonight's games), then one per game for a one-game display. The catalog's draft when markets has no real games.",
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
  makeFolder: {
    method: 'POST',
    path: '/boards/:account_id/folders',
    callers: ['edge'],
    params: acc,
    body: FolderBody,
    response: Board,
    status: 201,
    errors: [400, 404, 409],
    summary:
      'A new folder from 2-24 displays, in the order given (drop a widget on a widget). It takes `place`, else the first widget\'s place. A display may come from the grid or another folder; a folder this empties is removed. No folder in a folder. Default title: "NFL Week N" when every card is that NFL week\'s games, "NBA Tonight" when every card is tonight\'s NBA games, else "Folder". 400: an app or a folder in the list, a duplicate, a bad place. 409: the board\'s cap.',
  },
  setTitle: {
    method: 'PATCH',
    path: '/boards/:account_id/widgets/:widget_id/title',
    callers: ['edge'],
    params: z.object({ account_id: AccountId, widget_id: WidgetId }),
    body: z.object({ title: FolderTitle }).strict(),
    response: Widget,
    errors: [400, 404],
    summary: "Rename a folder (trimmed plain text). 400 for a display or an app.",
  },
  propose: {
    method: 'POST',
    path: '/boards/:account_id/proposals',
    callers: ['agent', 'edge'],
    params: acc,
    body: z.object({ changes: z.array(ProposalChange).min(1).max(6) }).strict(),
    response: Proposal,
    status: 201,
    errors: [400, 404],
    summary: "The agent's proposal, stored pending. Each add is validated against the widget catalog. edge: the Add app's hand-added widget (then accepted at once).",
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
    response: z.object({ job_id: z.string(), joined: Joined }).strict(),
    status: 202,
    errors: [404, 429],
    summary: 'Refresh now: enqueue a run, or join the run of the same kind already asked for in this minute.',
  },
  setConnection: {
    method: 'PUT',
    path: '/widgets/:widget_id/connection',
    callers: ['edge'],
    params: wid,
    body: z.object({ account_id: AccountId, connection_id: ConnectionId }).strict(),
    response: Widget,
    errors: [400, 404],
    summary:
      'Link a connected account to a "Your account" (positions) display: board checks the widget and the connection (connections.list) are the account\'s, sets params.connection_id and asks for a numbers run. The user\'s consent still gates what runner may read (connections.numbers).',
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
  putScreenshot: {
    method: 'PUT',
    path: '/widgets/:widget_id/screenshots/:run_id/:candidate_id',
    callers: ['runner'],
    params: screenshotParams,
    body: z.object({ account_id: AccountId, png_base64: PngBase64 }).strict(),
    response: z.object({ screenshot_key: z.string() }).strict(),
    errors: [400, 404],
    summary: "A source's screenshot from the browse sandbox, stored in Object Storage. The key goes in the run trace.",
  },
  getScreenshot: {
    method: 'GET',
    path: '/widgets/:widget_id/screenshots/:run_id/:candidate_id',
    callers: ['edge'],
    params: screenshotParams,
    query: accQuery,
    response: z.object({ screenshot_key: z.string(), content_type: z.literal('image/png'), png_base64: PngBase64 }).strict(),
    errors: [404],
    summary: 'A screenshot for the run trace, shown as an image labelled "external page".',
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
  lastOpened: {
    method: 'POST',
    path: '/last-opened',
    callers: ['runner'],
    body: z.object({ account_ids: z.array(AccountId).min(1).max(200) }).strict(),
    response: z
      .object({ boards: z.array(z.object({ account_id: AccountId, last_opened_at: Timestamp.nullable() }).strict()).max(200) })
      .strict(),
    summary: "When each board was last read by its owner (edge's getBoard). runner's scheduler runs only boards opened recently.",
  },
});
