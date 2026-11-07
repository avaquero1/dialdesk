# connections

The only service that holds users' exchange keys. It proves a Kalshi key is read-only before it keeps it, reads
balances and positions with GET requests only, and lets numbers out only when the user allows it.

## Connecting a Kalshi key (flow C)

1. The browser gets `GET /public-key` (X25519) and seals the PEM with `seal()` from `src/seal.ts` (WebCrypto: X25519,
   HKDF-SHA256, AES-256-GCM). The seal is bound to the account id and key id, so a body copied into another account or
   under another key id doesn't open. edge passes the body without reading it.
2. connections opens it, parses the key (Ed25519, or RSA of 2048 bits or more) and checks it is the type the user picked.
3. It calls Kalshi's `GET /api_keys` signed with that key, finds the pasted `api_key_id`, and checks its scopes against an
   allowlist (`read`, `read::portfolio_balance`). `write`, any `write::…` scope, and any scope it doesn't know are refused
   (403). It never sends a write to test a key: on a full-access key that would be a real order.
4. It stores the PEM encrypted at rest (AES-256-GCM, bound to the connection id) with the key id, type, checked scopes
   and the public key's fingerprint. audit gets the check with the key id and fingerprint only.

`CONNECTIONS_KALSHI_ENVS` decides which exchanges a key may be on. The default is `demo` (Kalshi's fake-money
exchange), so no real key reaches the public link. `demo,prod` allows a real read-only key.

## Keys

| Key | Where |
|---|---|
| Master key (32 bytes, base64) | `CONNECTIONS_MASTER_KEY_FILE`, a file only this container mounts (production `/run/secrets/connections-master`; dev `deploy/.dev/connections-master.key`, written by `make dev-secrets`, gitignored). No file, no start. |
| Seal key pair, data key | Derived from the master key with HKDF (`src/vault.ts`). Never stored. |
| Users' Kalshi keys | Only as ciphertext in `connections.connections.key_blob`. A database dump alone opens nothing. |

## GET only

Every exchange request goes through `getOnlyFetch` (`src/getonly.ts`). It refuses any method other than GET, a body, an
off-list origin or path, credentials in the URL, and redirects, before anything is sent. The lists:

- Kalshi (`external-api.kalshi.com` and `external-api.demo.kalshi.co`, `/trade-api/v2`): `/api_keys`,
  `/portfolio/balance`, `/portfolio/positions`.
- Polymarket (`data-api.polymarket.com`): `/v2/positions`. A wallet address is public data and needs no key.

`test/getonly.test.ts` proves it for every method, and scans `src/` for other methods, order paths and raw `fetch(`.

## Numbers

`account-refresh` jobs (BullMQ on `CONNECTIONS_VALKEY_URL`) re-read connections whose user allowed sharing, every
`CONNECTIONS_REFRESH_EVERY_S` (default 300 s), and right after consent. A rejected key or a bad answer fails its job without a
retry; 429 and 5xx retry per `QUEUE_RULES`. `GET /connections/:id/numbers` (runner) returns balance in cents and positions
(market id, side, count, average price in cents), and answers 403 without consent.

## The log (audit)

Ids, hashes and sizes only, with the `TRUST_ACTIONS` names the trust page reads:

| Action | When | Fields |
|---|---|---|
| `connection.scope_checked` | every Kalshi check (ok, refused, failed) and every Polymarket wallet added | `subject_id` = the connection (ok only), `ids.exchange`, `ids.scope`, `ids.key_id`, `ids.reason` when refused, `hashes.key` = public key fingerprint |
| `connection.removed` | disconnect | `subject_id`, `ids.exchange` |
| `consent.numbers_shared`, `consent.numbers_withdrawn` | the user allows or stops numbers leaving | `subject_id`, `ids.exchange` |
| `connection.refreshed` | an account-refresh read | `subject_id`, `sizes.positions` |

## Tests

`npx vitest run --project contracts services/connections/test`. They replay `test/recorded/` through a mock exchange that
checks Kalshi's signatures. Two more run only with a throwaway server: `CONNECTIONS_TEST_DATABASE_URL` (Postgres
store) and `CONNECTIONS_TEST_VALKEY_URL` (account-refresh on Valkey with the generated ACL file).
