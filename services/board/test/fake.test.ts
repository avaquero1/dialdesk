import { BOARD, type WidgetRunJob } from '@app/contracts';
import { MemoryBus } from '@app/service-kit';
import { fakeApp } from '@app/testkit';
import { fake } from '../src/fake.ts';
import { boardBehaviors } from './behaviors.ts';
import { marketsForBoard } from './cases.ts';

boardBehaviors('fake', async () => {
  const bus = new MemoryBus();
  const jobs: WidgetRunJob[] = [];
  const app = fakeApp('board', BOARD, fake({ bus, enqueue: (_q, j) => void jobs.push(j), markets: marketsForBoard() }));
  return { app, bus, jobs };
});
