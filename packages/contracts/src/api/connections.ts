import { z } from 'zod';
import { AccountId, ConnectionId, Exchange, MarketId, Ok, Timestamp } from '../common.ts';
import { api } from '../endpoint.ts';

export const Connection = z
  .object({
    connection_id: ConnectionId,
    account_id: AccountId,
    exchange: Exchange,
    label: z.string().max(60).describe('key id for Kalshi, a shortened wallet address for Polymarket'),
    scope: z.literal('read'),
    scope_verified: z.boolean().describe('false = "scope not verified"; real keys stay off the public link'),
    checked_at: Timestamp.nullable(),
    share_numbers: z.boolean().describe('the user allowed numbers to leave connections for their widgets'),
    public_data: z.boolean().describe('true for a Polymarket wallet address, labelled public data'),
  })
  .strict();
export type Connection = z.infer<typeof Connection>;

/** The browser encrypts the private key to connections' public key. edge passes the body opaque, with body logging off. */
export const ConnectBody = z.discriminatedUnion('exchange', [
  z
    .object({
      account_id: AccountId,
      exchange: z.literal('kalshi'),
      key_id: z.string().min(8).max(80),
      key_type: z.enum(['ed25519', 'rsa']),
      sealed_key: z.string().min(16).max(16384).describe('base64 of the sealed box; only connections can open it'),
      env: z.enum(['prod', 'demo']).describe('demo = Kalshi demo exchange (fake money)'),
    })
    .strict(),
  z
    .object({
      account_id: AccountId,
      exchange: z.literal('polymarket'),
      wallet: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    })
    .strict(),
]);

export const Numbers = z
  .object({
    connection_id: ConnectionId,
    balance_cents: z.number().int().nullable(),
    positions: z.array(
      z
        .object({
          market_id: MarketId,
          side: z.enum(['yes', 'no']),
          count: z.number().min(0),
          avg_price_cents: z.number().min(0).max(100),
        })
        .strict(),
    ),
    as_of: Timestamp,
  })
  .strict();
export type Numbers = z.infer<typeof Numbers>;

const cid = z.object({ connection_id: ConnectionId });
const accQuery = z.object({ account_id: AccountId });

export const CONNECTIONS = api('connections', {
  publicKey: {
    method: 'GET',
    path: '/public-key',
    callers: ['edge'],
    response: z.object({ alg: z.literal('x25519-sealed-box'), public_key: z.string() }).strict(),
    summary: 'The key the browser seals private keys to.',
  },
  connect: {
    method: 'POST',
    path: '/connections',
    callers: ['edge'],
    body: ConnectBody,
    response: Connection,
    status: 201,
    errors: [400, 403, 422],
    summary: "Connect an account. Kalshi: checks GET /api_keys, refuses any key with write scope (403).",
  },
  list: {
    method: 'GET',
    path: '/connections',
    callers: ['edge', 'board'],
    query: accQuery,
    response: z.object({ connections: z.array(Connection) }).strict(),
    summary: "An account's connections (board: to check a display's link belongs to the account).",
  },
  setConsent: {
    method: 'PUT',
    path: '/connections/:connection_id/consent',
    callers: ['edge'],
    params: cid,
    body: z.object({ account_id: AccountId, share_numbers: z.boolean() }).strict(),
    response: Connection,
    errors: [404],
    summary: 'The user allows (or stops) numbers leaving connections for their widgets.',
  },
  remove: {
    method: 'DELETE',
    path: '/connections/:connection_id',
    callers: ['edge'],
    params: cid,
    query: accQuery,
    response: Ok,
    errors: [404],
    summary: 'Disconnect and delete the stored key.',
  },
  numbers: {
    method: 'GET',
    path: '/connections/:connection_id/numbers',
    callers: ['runner'],
    params: cid,
    query: accQuery,
    response: Numbers,
    errors: [403, 404],
    summary: 'Balance and positions, numbers only, and only if the user allowed it (403 otherwise).',
  },
});
