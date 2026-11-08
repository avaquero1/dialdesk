/**
 * markets for `make e2e-live` (meeting point 2): the real service on the live Kalshi and Polymarket APIs, the catalog's
 * live feeds and, when its key file exists, Brave. Its own caches and spacers keep it polite. One change, for the
 * containment moment: a game of E2E_LIVE_POISON_TEAM (an event-key team code, e.g. `kc`) gets our own poisoned test page
 * (fixtures/site, served by the dev topology's fixture site, never the internet) as its first candidate, beside
 * LIVE_BESIDE_OURS live ones. The real planner still picks what to read: with five candidates it once took the four live
 * pages and left ours out, so this game offers fewer than max_sources (C2.1, run 1).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MARKETS, SOURCE_CATALOG } from '@app/contracts';
import { runService } from '@app/service-kit';
import { FIXTURES_DIR } from '@app/testkit';
import { toCandidates } from '../../services/markets/src/candidates.ts';
import { fake, fakeDepsFromEnv } from '../../services/markets/src/fake.ts';
import { real } from '../../services/markets/src/real.ts';

type Page = { url: string; poisoned: boolean };
const poisoned = (JSON.parse(readFileSync(join(FIXTURES_DIR, 'site', 'MANIFEST.json'), 'utf8')) as Page[]).find((p) => p.poisoned)!;
const team = (process.env.E2E_LIVE_POISON_TEAM ?? '').toLowerCase();
const LIVE_BESIDE_OURS = 2;
const fixtureRows = SOURCE_CATALOG.rows.filter((r) => r.env === 'fixture' && r.verified);

/** True when the event key (`nfl-2026-11-08-nyj-kc`) names the team. */
const playsIn = (eventKey: string | null | undefined, code: string) => !!code && !!eventKey && eventKey.split('-').slice(-2).includes(code);

await runService({
  service: 'markets',
  api: MARKETS,
  fake: async () => fake(await fakeDepsFromEnv()),
  real: (cfg) => {
    const h = real(cfg);
    return {
      ...h,
      candidates: async (input, ctx) => {
        const r = await h.candidates(input, ctx);
        const market = await h.get({ params: { market_id: input.params.market_id }, query: {}, body: undefined } as never, ctx);
        if (!playsIn(market.event_key, team)) return r;
        const host = new URL(poisoned.url).hostname;
        const [ours] = toCandidates([{ url: poisoned.url, domain: host, published_at: new Date().toISOString(), via: 'search' }], fixtureRows, new Set());
        ctx.log.info({ market_id: input.params.market_id, live: r.candidates.length }, 'e2e-live: our poisoned test page added');
        return { ...r, candidates: [ours!, ...r.candidates.filter((c) => c.allowed).slice(0, LIVE_BESIDE_OURS)] };
      },
    };
  },
  migrationsDir: fileURLToPath(new URL('../../services/markets/migrations', import.meta.url)),
});
