import { generateKeyPairSync } from 'node:crypto';
import { ACCOUNTS } from '@app/contracts';
import { MemoryBus, type Bus } from '@app/service-kit';
import { fakeApp } from '@app/testkit';
import { TEST_COST } from '../src/password.ts';
import { createAccounts, type AccountsOptions } from '../src/real.ts';
import { signingKeyFrom } from '../src/session.ts';
import { memoryStore, type Store } from '../src/store.ts';

/** A fresh signing key for one test file (never a file on disk, never committed). */
export const testKey = () => signingKeyFrom(generateKeyPairSync('ed25519').privateKey);

/** The real accounts on the memory store, with a small argon2 cost so tests stay fast. */
export function realAccounts(o: Partial<AccountsOptions> & { store?: Store; bus?: Bus } = {}) {
  const key = o.key ?? testKey();
  const store = o.store ?? memoryStore();
  const bus = o.bus ?? new MemoryBus();
  const handlers = createAccounts({ cost: TEST_COST, ...o, store, key, bus });
  return { app: fakeApp('accounts', ACCOUNTS, handlers), key, store, bus };
}
