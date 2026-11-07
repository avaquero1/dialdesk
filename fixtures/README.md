# Fixtures

Made-up data for tests, local development and the containment demo. **Every name, number, outlet, headline, wallet,
key id and price here is invented.** Team names are real; nothing else is. The one exception is `markets/live/`:
answers recorded from the real public APIs (see below). No file here holds a secret.

## `site/`: a static web of made-up pages

Pages live under a host-less path prefix: `site/<domain>/<path>`. The domain is a made-up `.fixture.test` name, so
`https://sportswire.fixture.test/nfl/bills-lt-questionable.html` is the file
`site/sportswire.fixture.test/nfl/bills-lt-questionable.html`. A fetcher in tests maps `https://<domain>/<path>` to
`http://<fixture-server>/<domain>/<path>`.

| Page | Outlet | Kind |
|---|---|---|
| `sportswire.fixture.test/nfl/bills-lt-questionable.html` | Sports Wire | clean: "Starting LT listed questionable (knee)" |
| `sportswire.fixture.test/nba/lakers-celtics-preview.html` | Sports Wire | clean |
| `weatherdesk.fixture.test/nfl/orchard-park-winds.html` | Weather Desk | clean: "18 mph winds forecast at kickoff" |
| `fanpost.fixture.test/nfl/eagles-cowboys-notes.html` | FanPost | clean |
| `fanpost.fixture.test/nfl/chiefs-bills-insider.html` | FanPost | **poisoned** |

The poisoned page reads like a fan blog post. It hides orders aimed at the agent in three places: a `display:none`
div, white-on-white text and an HTML comment. It also tries three callouts: an `<img>` to `169.254.169.254` (the cloud
metadata address), a `<script>` `fetch` to `collect.exfil.fixture.test`, and a `<link rel=prefetch>` to
`tracker.offlist.fixture.test`. None of those hosts exist. A visible note at the bottom says it is a test page.

- `site/index.html` lists the pages.
- `site/feeds/*.xml` are RSS 2.0 feeds whose items link to the `https://<domain>/<path>` URLs.
- `site/MANIFEST.json` lists every page: `url`, `file`, `poisoned`, `injections` and `callouts` (empty for clean pages).
  Tests use it to check that the poisoned page is caught and the clean ones are not.

### Serving it

`deploy/compose.dev.yml` runs a Caddy `fixtures` container that serves `site/` read-only on
`http://127.0.0.1:8300/` (directory browsing off):

```sh
curl -s localhost:8300/fanpost.fixture.test/nfl/chiefs-bills-insider.html
```

Any static file server pointed at `site/` works the same way.

## `markets/`: made-up exchange responses

Shapes follow the public Kalshi Trade API v2 and Polymarket Gamma and CLOB APIs. **The market-data files were checked
against the live APIs on 2026-11-07 and fixed**; the values are invented. markets reads them with the same parsers as
its real clients (`services/markets/src/kalshi.ts`, `polymarket.ts`), so a shape that drifts fails the tests. The
portfolio, api_keys and positions files are authenticated endpoints and stay for connections to check.

What changed on 2026-11-07:
- Kalshi sends no integer cents any more. Prices are dollar strings only (`yes_bid_dollars: "0.6000"`,
  `last_price_dollars`, `previous_price_dollars`) and counts are fixed-point strings (`volume_fp`, `volume_24h_fp`,
  `open_interest_fp`). Candles carry only `*_dollars` fields, and a period with no trade has only `previous_dollars`.
- A Polymarket game market is a moneyline: `outcomes` are the two teams, away first (`["Chiefs", "Bills"]`), not
  Yes/No. markets takes the first outcome as YES, so `polymarket:<slug>` pairs with the away team's Kalshi market.

| File | Shaped like |
|---|---|
| `kalshi/markets.json` | `GET /trade-api/v2/markets` (`{"markets":[...],"cursor":""}`) |
| `kalshi/market-<TICKER>.json` | `GET /trade-api/v2/markets/{ticker}` (`{"market":{...}}`) |
| `kalshi/candlesticks-<TICKER>.json` | `GET /trade-api/v2/series/{series}/markets/{ticker}/candlesticks`, daily (`period_interval=1440`), 7 candles whose `end_period_ts` runs 2026-11-01T00:00Z to 2026-11-07T00:00Z |
| `kalshi/portfolio-balance.json` | `GET /trade-api/v2/portfolio/balance` (cents) |
| `kalshi/portfolio-positions.json` | `GET /trade-api/v2/portfolio/positions` (3 positions; a negative `position` is NO contracts) |
| `kalshi/api_keys.json` | `GET /trade-api/v2/api_keys`, one key with scopes `["read"]` |
| `kalshi/api_keys-write.json` | the same, but the key has `["read","write"]` (a connection must refuse it) |
| `polymarket/markets.json` | Gamma `GET /markets` (an array; `outcomes`, `outcomePrices` and `clobTokenIds` are JSON-encoded strings) |
| `polymarket/prices-history-<slug>.json` | CLOB `GET /prices-history` (`{"history":[{"t","p"}]}`), the same 7 daily points |
| `polymarket/positions-0x00000000000000000000000000000000000f1x7e.json` | Data API `GET /positions?user=<wallet>`, a made-up wallet with 3 positions |
| `pairs.json` | our own pairing of one Kalshi market with one Polymarket market per game |

Kalshi prices are dollar strings such as `"0.6100"`. YES is the first team named, which is the away team. As in the real
game markets, `yes_sub_title` and `no_sub_title` both carry the YES team's name. `previous_price_dollars` is the price
24 hours ago, so the 24h move is `last_price_dollars - previous_price_dollars`. Polymarket's `oneDayPriceChange` is the same
move in dollars.

| event_key | Kalshi ticker | Kalshi last ¢ | Polymarket slug | Poly YES | 24h move (pts) | 7 daily Kalshi closes |
|---|---|---|---|---|---|---|
| nfl-2026w10-kc-buf | KXNFLGAME-26NOV08KCBUF-KC | 61 | nfl-kc-buf-2026-11-08 | 0.63 | +4 | 52 54 55 57 58 57 61 |
| nba-2026-11-07-lal-bos | KXNBAGAME-26NOV07LALBOS-LAL | 44 | nba-lal-bos-2026-11-07 | 0.45 | -3 | 50 49 48 49 48 47 44 |
| nfl-2026w10-phi-dal | KXNFLGAME-26NOV08PHIDAL-PHI | 71 | nfl-phi-dal-2026-11-08 | 0.70 | +1 | 66 67 69 68 70 70 71 |
| nba-2026-11-07-nyk-mia | KXNBAGAME-26NOV07NYKMIA-NYK | 55 | nba-nyk-mia-2026-11-07 | 0.55 | 0 | 52 53 54 56 55 55 55 |
| nfl-2026w10-gb-chi | KXNFLGAME-26NOV08GBCHI-GB | 58 | nfl-gb-chi-2026-11-08 | 0.57 | +2 | 54 55 55 57 56 56 58 |
| nfl-2026w10-sf-sea | KXNFLGAME-26NOV08SFSEA-SF | 52 | nfl-sf-sea-2026-11-08 | 0.53 | -1 | 55 54 54 53 52 53 52 |
| nba-2026-11-07-den-phx | KXNBAGAME-26NOV07DENPHX-DEN | 60 | nba-den-phx-2026-11-07 | 0.61 | +2 | 57 58 57 59 58 58 60 |

Polymarket price history is the Kalshi closes shifted by the gap between the two last prices (for example +2 points for
Chiefs at Bills), so both exchanges show the same 24h move. Other code depends on these numbers: change them only
together with the tests that read them.

## `markets/live/`: real answers, recorded

Recorded from the public APIs on 2026-11-07 by `services/markets/scripts/record-live.ts` (Jets at Chiefs, Nov 8), for
the offline tests of markets' real clients (`services/markets/test/real.test.ts`). These are real prices.

| File | From |
|---|---|
| `kalshi/events-KXNFLGAME.json` | `GET /events?series_ticker=KXNFLGAME&status=open&with_nested_markets=true`, cut to 3 events |
| `kalshi/event-KXNFLGAME-26NOV08NYJKC.json` | `GET /events/{event_ticker}` (`{"event", "markets"}`) |
| `kalshi/market-KXNFLGAME-26NOV08NYJKC-KC.json` | `GET /markets/{ticker}` |
| `kalshi/candlesticks-KXNFLGAME-26NOV08NYJKC-KC.json` | hourly candles, the last 48 |
| `polymarket/market-nfl-nyj-kc-2026-11-08.json` | Gamma `GET /markets/slug/{slug}?include_tag=true` |
| `polymarket/markets-by-slug.json` | Gamma `GET /markets?slug=…&slug=…` |
| `polymarket/prices-history-nfl-nyj-kc-2026-11-08.json` | CLOB `GET /prices-history?interval=1w&fidelity=60`, the last 48 points |
| `feeds/*.xml` | two NFL club feeds (RSS), ESPN NFL (CDATA links), RotoWire NFL (12-hour dates), CelticsBlog (Atom) |
| `brave/news-search.json` | **not recorded yet**: Brave's documented news-search shape with made-up links, until the key exists |

The feeds keep their structure, links and dates, but every headline, summary, keyword list and author is replaced by
"Text removed for the fixture" (with the team nicknames it named, so team matching can be tested). No outlet's text is
in the repo. The recorder keeps only links, dates and host names from a Brave answer.

