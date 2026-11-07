# Recorded exchange answers

The connections tests replay these instead of calling an exchange. No real key was used: they are shaped from the
exchanges' published schemas (Kalshi Trade API v2 `GetApiKeysResponse`, `GetBalanceResponse`, `GetPositionsResponse`
from docs.kalshi.com; Polymarket `PositionsPage` from data-api.polymarket.com/v2/openapi.json), checked on 2026-11-07.
Every id, wallet and amount is made up. Re-record them against the Kalshi demo exchange (fake money) once a demo key exists.

| File | What |
|---|---|
| `kalshi-api_keys-read.json` | `GET /api_keys`: the pasted key has scope `read` only (accepted) |
| `kalshi-api_keys-write.json` | the pasted key has `read` and `write`, Kalshi's default for a new key (refused) |
| `kalshi-api_keys-write-trade.json` | the pasted key has `read` and `write::trade` (refused) |
| `kalshi-api_keys-rsa-read.json` | an RSA key with scope `read` (accepted) |
| `kalshi-api_keys-other.json` | the account's keys, but not the pasted one (refused: key not listed) |
| `kalshi-portfolio-balance.json` | `GET /portfolio/balance` |
| `kalshi-portfolio-positions.json` | `GET /portfolio/positions` (fixed-point `position_fp` and `_dollars` strings) |
| `polymarket-v2-positions.json` | `GET /v2/positions?user=0x…`, the `{ data, pagination }` envelope |
