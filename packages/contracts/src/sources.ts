import { z } from 'zod';
import { CandidateId, Domain, SourceUrl, Timestamp } from './common.ts';

export const MarketCategory = z.enum(['sports', 'politics', 'economics', 'crypto']);
export const League = z.enum(['nfl', 'nba', 'mlb', 'nhl', 'ncaaf', 'ncaab', 'soccer']);

export const SourceId = z.string().regex(/^src-[a-z0-9-]{2,40}$/);

/** One row of the source catalog: a site and its feeds. A candidate on a catalog domain is allowed for that run (D2). */
export const SourceRow = z
  .object({
    source_id: SourceId,
    category: MarketCategory,
    leagues: z.array(League),
    domain: Domain,
    outlet: z.string().max(80).describe('shown to the user only, never to a model'),
    feeds: z.array(z.object({ url: SourceUrl, kind: z.enum(['rss', 'atom']) })),
    env: z.enum(['prod', 'fixture']).describe('fixture rows exist only in dev and test'),
    verified: z.boolean().describe('false until the markets worker checks the domain and feeds online'),
  })
  .strict();
export type SourceRow = z.infer<typeof SourceRow>;

export const SourceCatalog = z.object({ version: z.literal(0), rows: z.array(SourceRow) });
export type SourceCatalog = z.infer<typeof SourceCatalog>;

/** A candidate link, parsed by code (never by a model). Titles are data for the user, never for a model. */
export const Candidate = z
  .object({
    candidate_id: CandidateId,
    url: SourceUrl,
    domain: Domain,
    published_at: Timestamp.nullable(),
    via: z.enum(['catalog', 'feed', 'search']),
    source_id: SourceId.nullable().describe('null when the domain is not in the catalog'),
    allowed: z.boolean().describe('true only for catalog domains or domains the user added to this widget'),
    title_for_user: z.string().max(300).nullable(),
  })
  .strict();
export type Candidate = z.infer<typeof Candidate>;

/** What a planner may see of a candidate: id, domain and date. Nothing else. */
export const PlannerCandidate = Candidate.pick({ candidate_id: true, domain: true, published_at: true });

/**
 * v0 rows. Fixture rows match fixtures/site. Prod rows are placeholders until the markets worker (Phase 1) checks
 * the domains and feeds online and flips `verified`.
 */
export const SOURCE_CATALOG: SourceCatalog = {
  version: 0,
  rows: [
    {
      source_id: 'src-sportswire',
      category: 'sports',
      leagues: ['nfl', 'nba'],
      domain: 'sportswire.fixture.test',
      outlet: 'Sports Wire',
      feeds: [
        { url: 'http://127.0.0.1:8300/feeds/sportswire-nfl.xml', kind: 'rss' },
        { url: 'http://127.0.0.1:8300/feeds/sportswire-nba.xml', kind: 'rss' },
      ],
      env: 'fixture',
      verified: true,
    },
    {
      source_id: 'src-weatherdesk',
      category: 'sports',
      leagues: ['nfl'],
      domain: 'weatherdesk.fixture.test',
      outlet: 'Weather Desk',
      feeds: [],
      env: 'fixture',
      verified: true,
    },
    {
      source_id: 'src-fanpost',
      category: 'sports',
      leagues: ['nfl'],
      domain: 'fanpost.fixture.test',
      outlet: 'Fan Post',
      feeds: [{ url: 'http://127.0.0.1:8300/feeds/fanpost-nfl.xml', kind: 'rss' }],
      env: 'fixture',
      verified: true,
    },
  ],
};
