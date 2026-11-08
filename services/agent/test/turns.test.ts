/**
 * A1.3.1: the real agent on the models fake, turn by turn. The fake plays multi-step turns from the last user message
 * and the tool results so far, so the first visit goes the way design.md section 7 says: the greeting asks which teams
 * or markets the user follows with leagues to tap, then that league's teams, then a named team gets widgets proposed
 * as chips. Costs nothing: no Vultr call.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { AGENT, BOARD, MARKETS, MODELS, type ChatReply } from '@app/contracts';
import { MemoryBus, buildApp, createClient, createLogger } from '@app/service-kit';
import { fakeApp, testCallers, TEST_TOKENS } from '@app/testkit';
import { fake as boardFake } from '../../board/src/fake.ts';
import { fake as marketsFake } from '../../markets/src/fake.ts';
import { fake as modelsFake } from '../../models/src/fake.ts';
import { createReal } from '../src/real.ts';
import { MemoryConversationStore } from '../src/store.ts';

const ACC = 'acc_agentturns001';
type App = { fetch: (r: Request) => Response | Promise<Response> };
const as = (caller: keyof typeof TEST_TOKENS, app: App) => createClient({ baseUrl: 'http://svc.internal', token: TEST_TOKENS[caller], fetch: (r) => app.fetch(r) });

let agentApp: ReturnType<typeof buildApp>;
let boardApp: ReturnType<typeof fakeApp>;
const modelCalls: { role: string; last: string }[] = [];

const chat = async (message: string, conversation_id: string | null) => {
  const res = await agentApp.request('/chat', {
    method: 'POST',
    headers: { authorization: `Bearer ${TEST_TOKENS.edge}`, 'content-type': 'application/json' },
    body: JSON.stringify({ account_id: ACC, conversation_id, widget_id: null, message }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as ChatReply;
};

beforeAll(async () => {
  const log = createLogger('test', 'silent');
  const models = fakeApp('models', MODELS, modelsFake());
  const counted: App = {
    fetch: async (r) => {
      const body = (await r.clone().json()) as { role: string; messages: { role: string }[] };
      modelCalls.push({ role: body.role, last: body.messages.at(-1)!.role });
      return models.fetch(r);
    },
  };
  const markets = fakeApp('markets', MARKETS, marketsFake());
  boardApp = fakeApp('board', BOARD, boardFake({ markets: as('board', markets) }));
  const handlers = createReal({ models: as('agent', counted), board: as('agent', boardApp), markets: as('agent', markets), store: new MemoryConversationStore(), bus: new MemoryBus(), log });
  agentApp = buildApp({ service: 'agent', mode: 'real', api: AGENT, handlers, callers: testCallers(), log });
  await as('edge', boardApp)(BOARD.createDefaults, { params: { account_id: ACC }, body: { category: 'sports' } });
});

describe('agent on the models fake: the chat builds a board', () => {
  let cnv: string;

  it('the first visit asks which teams or markets, with leagues to tap', async () => {
    const r = await chat('Hi', null);
    cnv = r.conversation_id;
    expect(r.turn.text).toBe('Hi. Which teams or markets do you follow?');
    expect(r.turn.chips).toEqual([]);
    expect(r.turn.picks).toEqual(expect.arrayContaining(['NFL', 'NBA']));
  });

  it('a league tapped: its teams to tap', async () => {
    const r = await chat('NFL', cnv);
    expect(r.turn.text).toBe('Which NFL teams do you follow?');
    expect(r.turn.picks).toEqual(expect.arrayContaining(['Bills', 'Chiefs', '49ers']));
    expect(r.turn.picks).not.toContain('Lakers');
  });

  it('a team tapped: two widgets proposed as chips over three model steps, nothing added before the tap', async () => {
    const before = (await as('agent', boardApp)(BOARD.getBoard, { params: { account_id: ACC } })).widgets.length;
    modelCalls.length = 0;
    const r = await chat('Bills', cnv);
    // tool call, tool call, then words; the guard's layer two is the fourth call.
    expect(modelCalls.filter((c) => c.role === 'chat').map((c) => c.last)).toEqual(['user', 'tool', 'tool']);
    // The line written beside the first tool call is kept, before the last reply.
    expect(r.turn.text).toBe('Building your Bills board. The Bills news and the price move for Chiefs at Bills. Tap to add them.');
    expect(r.turn.picks).toBeUndefined();
    expect(r.turn.chips.map((c) => [c.tool, c.status, c.label])).toEqual([
      ['propose_widget', 'proposed', 'Chiefs at Bills news'],
      ['propose_widget', 'proposed', 'Chiefs at Bills move'],
    ]);
    const b = await as('agent', boardApp)(BOARD.getBoard, { params: { account_id: ACC } });
    expect(b.widgets.length).toBe(before);
    expect(b.pending.map((p) => p.proposal_id).sort()).toEqual(r.turn.chips.map((c) => c.proposal_id).sort());
    const news = b.pending.find((p) => p.proposal_id === r.turn.chips[0]!.proposal_id)!.changes[0];
    expect(news).toMatchObject({ op: 'add', widget: { type: 'news', params: { team: 'Bills', event_keys: ['nfl-2026w10-kc-buf'] } } });
  });

  it('a later turn follows what the user said: advice bait gets the math, filled by code', async () => {
    const r = await chat('Should I buy YES on the Chiefs?', cnv);
    expect(r.turn.text).toMatch(/^I do math, not calls\. The market says [0-9.]+%, (up|down) [0-9.]+ points? since yesterday\. Want a widget for this game\?$/);
    expect(r.turn.chips.map((c) => c.tool)).toEqual(['quote_market']);
  });

  it('a look change, then words', async () => {
    const r = await chat('Make it warmer', cnv);
    expect(r.turn.text).toBe('Done: warmer glass.');
    expect(r.turn.chips[0]).toMatchObject({ tool: 'set_look', status: 'applied', args: { hue: 32 } });
  });

  it('advice wording from the model is blocked', async () => {
    const r = await chat('advice-test', cnv);
    expect(r.turn.text).toBe('I do math, not calls.');
    expect(r.turn.chips).toEqual([]);
  });
});
