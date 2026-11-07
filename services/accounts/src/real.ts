import { ACCOUNTS } from '@app/contracts';
import { unbuilt, type Handlers } from '@app/service-kit';

/** The real accounts. Phase 0: nothing is built, every endpoint answers 501. Replace one handler at a time. */
export function real(): Handlers<typeof ACCOUNTS> {
  return unbuilt(ACCOUNTS);
}
