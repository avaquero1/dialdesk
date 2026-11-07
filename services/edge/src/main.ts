import { EDGE } from '@app/contracts';
import { runService } from '@app/service-kit';
import { createFakeEdge, fakeDepsFromEnv } from './fake.ts';
import { real } from './real.ts';

// The fake's session check is the fake one; the real edge (Phase 1) brings its JWT check with its handlers.
const fakeEdge = process.env.EDGE_FAKE === '1' ? createFakeEdge(await fakeDepsFromEnv()) : null;

await runService({
  service: 'edge',
  api: EDGE,
  fake: () => fakeEdge!.handlers,
  real,
  sessionCheck: fakeEdge?.sessionCheck,
});
