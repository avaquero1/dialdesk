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
    feeds: z.array(
      z.object({
        url: SourceUrl,
        kind: z.enum(['rss', 'atom']),
        team: z
          .string()
          .regex(/^[a-z0-9]{2,4}$/)
          .optional()
          .describe("a team feed: the team's code (Kalshi's code in lower case, e.g. kc). Absent for league-wide feeds"),
      }),
    ),
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

type Feed = SourceRow['feeds'][number];
const prodRow = (source_id: string, leagues: SourceRow['leagues'], domain: string, outlet: string, feeds: Feed[]): SourceRow => ({
  source_id,
  category: 'sports',
  leagues,
  domain,
  outlet,
  feeds,
  env: 'prod',
  verified: true,
});

/** Each NFL club's own site: www.<domain>/rss/news (RSS 2.0). */
const NFL_CLUBS: [string, string, string][] = [
  ['ari', 'azcardinals.com', 'Arizona Cardinals'],
  ['atl', 'atlantafalcons.com', 'Atlanta Falcons'],
  ['bal', 'baltimoreravens.com', 'Baltimore Ravens'],
  ['buf', 'buffalobills.com', 'Buffalo Bills'],
  ['car', 'panthers.com', 'Carolina Panthers'],
  ['chi', 'chicagobears.com', 'Chicago Bears'],
  ['cin', 'bengals.com', 'Cincinnati Bengals'],
  ['cle', 'clevelandbrowns.com', 'Cleveland Browns'],
  ['dal', 'dallascowboys.com', 'Dallas Cowboys'],
  ['den', 'denverbroncos.com', 'Denver Broncos'],
  ['det', 'detroitlions.com', 'Detroit Lions'],
  ['gb', 'packers.com', 'Green Bay Packers'],
  ['hou', 'houstontexans.com', 'Houston Texans'],
  ['ind', 'colts.com', 'Indianapolis Colts'],
  ['jac', 'jaguars.com', 'Jacksonville Jaguars'],
  ['kc', 'chiefs.com', 'Kansas City Chiefs'],
  ['lv', 'raiders.com', 'Las Vegas Raiders'],
  ['lac', 'chargers.com', 'Los Angeles Chargers'],
  ['lar', 'therams.com', 'Los Angeles Rams'],
  ['mia', 'miamidolphins.com', 'Miami Dolphins'],
  ['min', 'vikings.com', 'Minnesota Vikings'],
  ['ne', 'patriots.com', 'New England Patriots'],
  ['no', 'neworleanssaints.com', 'New Orleans Saints'],
  ['nyg', 'giants.com', 'New York Giants'],
  ['nyj', 'newyorkjets.com', 'New York Jets'],
  ['phi', 'philadelphiaeagles.com', 'Philadelphia Eagles'],
  ['pit', 'steelers.com', 'Pittsburgh Steelers'],
  ['sf', '49ers.com', 'San Francisco 49ers'],
  ['sea', 'seahawks.com', 'Seattle Seahawks'],
  ['tb', 'buccaneers.com', 'Tampa Bay Buccaneers'],
  ['ten', 'tennesseetitans.com', 'Tennessee Titans'],
  ['was', 'commanders.com', 'Washington Commanders'],
];

/** One team blog per NBA club (the leagues' club sites have no feeds). Domain, outlet, feed URL, feed kind. */
const NBA_BLOGS: [string, string, string, string, Feed['kind']][] = [
  ['atl', 'peachtreehoops.com', 'Peachtree Hoops', 'https://www.peachtreehoops.com/rss/index.xml', 'atom'],
  ['bos', 'celticsblog.com', 'CelticsBlog', 'https://www.celticsblog.com/rss/index.xml', 'atom'],
  ['bkn', 'netsdaily.com', 'NetsDaily', 'https://www.netsdaily.com/rss/index.xml', 'atom'],
  ['cha', 'atthehive.com', 'At The Hive', 'https://atthehive.com/feed/', 'rss'],
  ['chi', 'blogabull.com', 'Blog a Bull', 'https://www.blogabull.com/feed', 'rss'],
  ['cle', 'fearthesword.com', 'Fear The Sword', 'https://www.fearthesword.com/rss/index.xml', 'atom'],
  ['dal', 'mavsmoneyball.com', 'Mavs Moneyball', 'https://www.mavsmoneyball.com/rss/index.xml', 'atom'],
  ['den', 'denverstiffs.com', 'Denver Stiffs', 'https://feeds.denverstiffs.com/feed/', 'rss'],
  ['det', 'detroitbadboys.com', 'Detroit Bad Boys', 'https://www.detroitbadboys.com/rss/index.xml', 'atom'],
  ['gsw', 'goldenstateofmind.com', 'Golden State of Mind', 'https://www.goldenstateofmind.com/rss/index.xml', 'atom'],
  ['hou', 'thedreamshake.com', 'The Dream Shake', 'https://www.thedreamshake.com/rss/index.xml', 'atom'],
  ['ind', 'indycornrows.com', 'Indy Cornrows', 'https://www.indycornrows.com/feed', 'rss'],
  ['lac', 'clipperholics.com', 'Clipperholics', 'https://clipperholics.com/feed', 'rss'],
  ['lal', 'silverscreenandroll.com', 'Silver Screen and Roll', 'https://www.silverscreenandroll.com/rss/index.xml', 'atom'],
  ['mem', 'bealestreetbears.com', 'Beale Street Bears', 'https://bealestreetbears.com/feed', 'rss'],
  ['mia', 'hothothoops.com', 'Hot Hot Hoops', 'https://hothothoops.com/feed/', 'rss'],
  ['mil', 'brewhoop.com', 'Brew Hoop', 'https://www.brewhoop.com/rss/index.xml', 'atom'],
  ['min', 'canishoopus.com', 'Canis Hoopus', 'https://www.canishoopus.com/rss/index.xml', 'atom'],
  ['nop', 'pelicandebrief.com', 'Pelican Debrief', 'https://pelicandebrief.com/feed', 'rss'],
  ['nyk', 'postingandtoasting.com', 'Posting and Toasting', 'https://www.postingandtoasting.com/rss/index.xml', 'atom'],
  ['okc', 'thunderousintentions.com', 'Thunderous Intentions', 'https://thunderousintentions.com/feed', 'rss'],
  ['orl', 'orlandomagicdaily.com', 'Orlando Magic Daily', 'https://orlandomagicdaily.com/feed', 'rss'],
  ['phi', 'libertyballers.com', 'Liberty Ballers', 'https://www.libertyballers.com/rss/index.xml', 'atom'],
  ['phx', 'brightsideofthesun.com', 'Bright Side of the Sun', 'https://www.brightsideofthesun.com/rss/index.xml', 'atom'],
  ['por', 'blazersedge.com', 'Blazersedge', 'https://www.blazersedge.com/rss/index.xml', 'atom'],
  ['sac', 'kingsherald.com', 'Kings Herald', 'https://kingsherald.com/feed/', 'rss'],
  ['sas', 'poundingtherock.com', 'Pounding The Rock', 'https://www.poundingtherock.com/rss/index.xml', 'atom'],
  ['tor', 'raptorshq.com', 'Raptors HQ', 'https://www.raptorshq.com/rss/index.xml', 'atom'],
  ['uta', 'slcdunk.com', 'SLC Dunk', 'https://www.slcdunk.com/rss/index.xml', 'atom'],
  ['was', 'bulletsforever.com', 'Bullets Forever', 'https://www.bulletsforever.com/rss/index.xml', 'atom'],
];

/**
 * Production rows, sports first (Q7): league-wide news, then one row per NFL club and per NBA team blog. Each feed
 * was fetched and parsed by code on 2026-11-07 (items with links on the row's domain, newest item under 10 days
 * old); `services/markets/scripts/verify-sources.ts` checks them again. Dead ends on that day: ESPN's per-team feeds
 * (every team gets the same top stories), nfl.com and nba.com (no working feed), USA Today's team "Wire" sites (402).
 */
export const PROD_SOURCE_ROWS: SourceRow[] = [
  prodRow('src-espn', ['nfl', 'nba'], 'espn.com', 'ESPN', [
    { url: 'https://www.espn.com/espn/rss/nfl/news', kind: 'rss' },
    { url: 'https://www.espn.com/espn/rss/nba/news', kind: 'rss' },
  ]),
  prodRow('src-cbssports', ['nfl', 'nba'], 'cbssports.com', 'CBS Sports', [
    { url: 'https://www.cbssports.com/rss/headlines/nfl/', kind: 'rss' },
    { url: 'https://www.cbssports.com/rss/headlines/nba/', kind: 'rss' },
  ]),
  prodRow('src-yahoo-sports', ['nfl', 'nba'], 'sports.yahoo.com', 'Yahoo Sports', [
    { url: 'https://sports.yahoo.com/nfl/rss/', kind: 'rss' },
    { url: 'https://sports.yahoo.com/nba/rss/', kind: 'rss' },
  ]),
  prodRow('src-rotowire', ['nfl', 'nba'], 'rotowire.com', 'RotoWire', [
    { url: 'https://www.rotowire.com/rss/news.php?sport=NFL', kind: 'rss' },
    { url: 'https://www.rotowire.com/rss/news.php?sport=NBA', kind: 'rss' },
  ]),
  prodRow('src-sbnation', ['nfl', 'nba'], 'sbnation.com', 'SB Nation', [
    { url: 'https://www.sbnation.com/rss/nfl/index.xml', kind: 'atom' },
    { url: 'https://www.sbnation.com/rss/nba/index.xml', kind: 'atom' },
  ]),
  prodRow('src-profootballtalk', ['nfl'], 'nbcsports.com', 'NBC Sports (ProFootballTalk)', [
    { url: 'https://www.nbcsports.com/profootballtalk.rss', kind: 'rss' },
  ]),
  prodRow('src-pff', ['nfl'], 'pff.com', 'PFF', [{ url: 'https://www.pff.com/feed', kind: 'rss' }]),
  ...NFL_CLUBS.map(([team, domain, outlet]) =>
    prodRow(`src-nfl-${team}`, ['nfl'], domain, outlet, [{ url: `https://www.${domain}/rss/news`, kind: 'rss', team }]),
  ),
  ...NBA_BLOGS.map(([team, domain, outlet, url, kind]) => prodRow(`src-nba-${team}`, ['nba'], domain, outlet, [{ url, kind, team }])),
];

/** v0 rows: the fixture rows (they match fixtures/site) and the production rows above. */
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
    ...PROD_SOURCE_ROWS,
  ],
};
