/**
 * edge's browser API: the only door behind caddy. Every route except `public` ones needs the session cookie;
 * edge fills `account_id` from the session, so browser bodies never carry it.
 */
import { z } from 'zod';
import { ConversationId, Domain, Ok, ProposalId, ReceiptId, WidgetId } from '../common.ts';
import { DisplaySize } from '../catalog.ts';
import { api } from '../endpoint.ts';
import { Look } from '../look.ts';
import { Place } from '../widget.ts';
import { EngineReceipt } from '../rust.ts';
import { RunTraceStep } from '../result.ts';
import { Account, Email, Password } from './accounts.ts';
import { ChatReply } from './agent.ts';
import { Board, Proposal, Widget } from './board.ts';
import { Connection } from './connections.ts';
import { Spend } from './models.ts';
import { SignedHead, TrustCounts } from './audit.ts';

/** The session cookie: HttpOnly, Secure, SameSite=Strict, Path=/. */
export const SESSION_COOKIE = 'app_session';
/** The WebSocket path for live events (BrowserEvent frames). The handshake checks the Origin and the session. */
export const LIVE_PATH = '/live';

const wid = z.object({ widget_id: WidgetId });
const pid = z.object({ proposal_id: ProposalId });
const conn = z.object({ connection_id: z.string() });

export const EDGE = api('edge', {
  signup: {
    method: 'POST',
    path: '/api/signup',
    callers: ['public'],
    body: z.object({ email: Email, password: Password }).strict(),
    response: z.object({ account: Account }).strict(),
    status: 201,
    errors: [400, 409, 429],
    summary: 'Sign up; sets the session cookie; creates the default board.',
  },
  guest: {
    method: 'POST',
    path: '/api/guest',
    callers: ['public'],
    body: z.object({}).strict(),
    response: z.object({ account: Account }).strict(),
    status: 201,
    errors: [429],
    summary: '"Try it": a guest with the pre-built board.',
  },
  login: {
    method: 'POST',
    path: '/api/login',
    callers: ['public'],
    body: z.object({ email: Email, password: Password }).strict(),
    response: z.object({ account: Account }).strict(),
    status: 201,
    errors: [400, 401, 429],
    summary: 'Log in; sets the session cookie.',
  },
  logout: { method: 'POST', path: '/api/logout', callers: ['browser'], body: z.object({}).strict(), response: Ok, summary: 'Log out.' },
  me: { method: 'GET', path: '/api/me', callers: ['browser'], response: Account, summary: 'The signed-in account.' },
  board: { method: 'GET', path: '/api/board', callers: ['browser'], response: Board, summary: 'The whole board.' },
  setLayout: {
    method: 'PUT',
    path: '/api/board/layout',
    callers: ['browser'],
    body: z.object({ places: z.array(z.object({ widget_id: WidgetId, place: Place }).strict()).max(200) }).strict(),
    response: Board,
    errors: [400],
    summary: 'Drags, drops and folders (board validates the places).',
  },
  chat: {
    method: 'POST',
    path: '/api/chat',
    callers: ['browser'],
    body: z
      .object({ conversation_id: ConversationId.nullable(), widget_id: WidgetId.nullable(), message: z.string().min(1).max(2000) })
      .strict(),
    response: ChatReply,
    errors: [400, 429],
    summary: 'One chat turn (guarded).',
  },
  accept: {
    method: 'POST',
    path: '/api/proposals/:proposal_id/accept',
    callers: ['browser'],
    params: pid,
    body: z.object({}).strict(),
    response: z.object({ proposal: Proposal, widgets: z.array(Widget) }).strict(),
    errors: [404, 409],
    summary: "The user's click on a proposal.",
  },
  reject: {
    method: 'POST',
    path: '/api/proposals/:proposal_id/reject',
    callers: ['browser'],
    params: pid,
    body: z.object({}).strict(),
    response: Proposal,
    errors: [404, 409],
    summary: 'No thanks.',
  },
  resize: {
    method: 'PATCH',
    path: '/api/widgets/:widget_id/size',
    callers: ['browser'],
    params: wid,
    body: z.object({ size: DisplaySize }).strict(),
    response: Widget,
    errors: [400, 404],
    summary: 'Menu: Size.',
  },
  clear: {
    method: 'POST',
    path: '/api/widgets/:widget_id/clear',
    callers: ['browser'],
    params: wid,
    body: z.object({}).strict(),
    response: Widget,
    errors: [404],
    summary: 'Menu: Clear all.',
  },
  remove: { method: 'DELETE', path: '/api/widgets/:widget_id', callers: ['browser'], params: wid, response: Ok, errors: [404], summary: 'Menu: Remove from board.' },
  refresh: {
    method: 'POST',
    path: '/api/widgets/:widget_id/refresh',
    callers: ['browser'],
    params: wid,
    body: z.object({}).strict(),
    response: z.object({ job_id: z.string() }).strict(),
    status: 202,
    errors: [404, 429],
    summary: 'Menu: Refresh now.',
  },
  addSource: {
    method: 'POST',
    path: '/api/widgets/:widget_id/sources',
    callers: ['browser'],
    params: wid,
    body: z.object({ domain: Domain }).strict(),
    response: Widget,
    errors: [400, 404],
    summary: 'Allow a suggested source for this widget.',
  },
  trace: {
    method: 'GET',
    path: '/api/widgets/:widget_id/trace',
    callers: ['browser'],
    params: wid,
    response: z.object({ steps: z.array(RunTraceStep) }).strict(),
    errors: [404],
    summary: 'Menu: Sources and receipts.',
  },
  receipt: {
    method: 'GET',
    path: '/api/receipts/:receipt_id',
    callers: ['browser'],
    params: z.object({ receipt_id: ReceiptId }),
    response: EngineReceipt,
    errors: [404],
    summary: 'One receipt.',
  },
  setLook: { method: 'PUT', path: '/api/look', callers: ['browser'], body: Look, response: Look, errors: [400], summary: 'Save the look.' },
  connectionsKey: {
    method: 'GET',
    path: '/api/connections/public-key',
    callers: ['browser'],
    response: z.object({ alg: z.literal('x25519-sealed-box'), public_key: z.string() }).strict(),
    summary: 'The key to seal a private key to, in the browser.',
  },
  connections: {
    method: 'GET',
    path: '/api/connections',
    callers: ['browser'],
    response: z.object({ connections: z.array(Connection) }).strict(),
    summary: 'Connected accounts.',
  },
  connect: {
    method: 'POST',
    path: '/api/connections',
    callers: ['browser'],
    body: z.record(z.string(), z.unknown()).describe('opaque: passed to connections unread, body logging off'),
    response: Connection,
    status: 201,
    errors: [400, 403, 422],
    summary: 'Connect an account (read only).',
  },
  consent: {
    method: 'PUT',
    path: '/api/connections/:connection_id/consent',
    callers: ['browser'],
    params: conn,
    body: z.object({ share_numbers: z.boolean() }).strict(),
    response: Connection,
    errors: [404],
    summary: 'Allow numbers to reach widgets.',
  },
  disconnect: {
    method: 'DELETE',
    path: '/api/connections/:connection_id',
    callers: ['browser'],
    params: conn,
    response: Ok,
    errors: [404],
    summary: 'Disconnect.',
  },
  trust: {
    method: 'GET',
    path: '/api/trust',
    callers: ['browser'],
    response: z.object({ counts: TrustCounts, spend: Spend }).strict(),
    summary: 'The trust page.',
  },
  auditHead: { method: 'GET', path: '/api/audit/head', callers: ['browser', 'public'], response: SignedHead, summary: 'The signed head.' },
  auditVerify: {
    method: 'GET',
    path: '/api/audit/verify',
    callers: ['browser', 'public'],
    response: z.object({ ok: z.boolean(), checked: z.number().int().min(0), first_bad_seq: z.number().int().nullable(), head: SignedHead }).strict(),
    summary: 'Verify the chain.',
  },
});
