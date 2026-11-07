import { CONNECTIONS } from '@app/contracts';
import { unbuilt, type Handlers } from '@app/service-kit';

/** The real connections. Phase 0: nothing is built, every endpoint answers 501. Replace one handler at a time. */
export function real(): Handlers<typeof CONNECTIONS> {
  return unbuilt(CONNECTIONS);
}
