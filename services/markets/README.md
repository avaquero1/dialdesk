# markets

Public exchange data and sources. It reads Kalshi's and Polymarket's public market data (never a user's key), the
source catalog's news feeds and Brave Search, and caches all of it by what was fetched, never by who asked: every user
who follows a market shares one copy.

## What it answers

| Endpoint | Real mode |
|---|---|
| `GET /markets` | The open NFL and NBA games on Kalshi (both teams' markets) with each game's Polymarket moneyline. Other categories answer an empty list for now (sports first). |
| `GET /markets/:id` | One market. `kalshi:<TICKER>` or `polymarket:<slug>`. Other Kalshi and Polymarket markets work too when their category is sports, politics, economics or crypto. |
| `GET /markets/:id/history` | Kalshi candlesticks (1 min up to 6 h, hourly up to 7 d, daily beyond) or Polymarket CLOB history, cut to `window_s`. |
| `GET /events/:event_key` | One game on both exchanges. Event keys are `<league>-<ET date>-<away>-<home>`, e.g. `nfl-2026-11-08-nyj-kc`. |
| `GET /markets/:id/candidates` | Step 0 of a research run, code only: links from the game's league and team feeds and one Brave search, as id, link, domain and date. No titles. |

**YES.** A Kalshi game has one market per team (YES = that team wins). A Polymarket game is one moneyline market whose
outcomes are the two teams, away first; markets takes the first outcome as YES. So `polymarket:nfl-nyj-kc-2026-11-08`
pairs with `kalshi:KXNFLGAME-26NOV08NYJKC-NYJ` (both: the Jets win).

**Names.** Both exchanges list the away team first and use the same team codes, except the NFL's Jaguars (Kalshi `JAC`,
Polymarket `jax`) and Rams (`LAR`, `la`): see `src/teams.ts`. Kalshi dates a game by its ET day. Polymarket dates NFL
night games by the UTC day (`nfl-tb-chi-2026-11-09` for a Sunday-night game on Nov 8 ET), so markets tries both days and
keys the event by the ET day of `gameStartTime`.

## Caching

| What | Key | Default |
|---|---|---|
| A quote (market) | the market | 15 s (`MARKETS_QUOTE_TTL_S`, 10-30) |
| A league's game list | the league and exchange | 30 s; it also refreshes each listed quote |
| History | the market and window | 60 s |
| A feed | the feed URL | 10 min |
| A Brave search | `brave:<event key>`: one per game, shared by both teams' markets on both exchanges | 30 min, kept in Postgres (`search_cache`) across restarts |

Concurrent misses share one fetch. When an exchange is down, the last cached value is served with `stale: true` and its
original `as_of`. With nothing cached, the endpoint answers 503.

## Sources

The production rows of `SOURCE_CATALOG` (`packages/contracts/src/sources.ts`): 7 league-wide outlets (ESPN, CBS Sports,
Yahoo Sports, RotoWire, SB Nation, ProFootballTalk, PFF), each NFL club's own site and one blog per NBA team. A game reads
its league's feeds (items that name one of the two teams) and both teams' feeds, newest first, from the last 96 h.
Feeds are untrusted: they are parsed by code for link and date only (no DTDs, no entity expansion, http(s) links on real
host names, tracking parameters dropped). `npm run verify-sources -w services/markets` re-checks every feed online.

## Brave

The key is read from the file in `MARKETS_BRAVE_KEY_FILE` on each search, so it can be added while the service runs. It
goes only in the request header: never in a log, an error, a receipt or an answer. Without the file, search is skipped
with one log line and the candidates come from the feeds. The query is built by code (the two teams' names and the
league) and goes in the receipt. Searches are spaced one second apart (Brave's free plan) and a 429 skips the search.

## Rate limits seen (2026-11-07)

No 429 from Kalshi, Gamma or the CLOB at 30 requests at once. No rate-limit headers from any of them. Kalshi answers with
`cache-control: public, max-age=15` and Gamma with `max-age=300` on lists; the CLOB caches history 90 s. Gamma's
`/events` list is deprecated (a sunset header points to `/events/keyset`); markets doesn't use it. A league's game
list costs 2 requests (one Kalshi events page, one Gamma multi-slug read).

## Scripts and tests

- `npm run verify-sources -w services/markets`: every production feed, online.
- `npm run record-live -w services/markets [event-key]`: re-records `fixtures/markets/live/` (and a Brave answer when the key exists).
- `npm run test:live -w services/markets`: the contract cases against the live APIs (needs the network; the gate skips it).
- `test/real.test.ts` (in the gate): the real handlers on the recorded answers, through the service template in real mode.
