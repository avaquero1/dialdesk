import { BOARD } from '@app/contracts';
import { unbuilt, type Handlers } from '@app/service-kit';

/** The real board. Phase 0: nothing is built, every endpoint answers 501. Replace one handler at a time. */
export function real(): Handlers<typeof BOARD> {
  return unbuilt(BOARD);
}
