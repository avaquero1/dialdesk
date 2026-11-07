import { MODELS } from '@app/contracts';
import { unbuilt, type Handlers } from '@app/service-kit';

/** The real models. Phase 0: nothing is built, every endpoint answers 501. Replace one handler at a time. */
export function real(): Handlers<typeof MODELS> {
  return unbuilt(MODELS);
}
