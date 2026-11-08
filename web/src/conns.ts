/**
 * The user's connected accounts, as edge last listed them (GET /api/connections): no key, only the label, the scope
 * and when it was checked. Shared by the Accounts sheet, the "Your account" display and Safety's consents, with no
 * imports, so widgets.ts can read it without a cycle.
 */
import type { Connection } from '@app/contracts';

export type { Connection };

let list: Connection[] = [];
const subs = new Set<() => void>();

export const connections = (): readonly Connection[] => list;
export const exchangeName = (e: string) => (e === 'kalshi' ? 'Kalshi' : e === 'polymarket' ? 'Polymarket' : e);

export function setConnections(next: Connection[]) {
  list = next;
  for (const f of subs) f();
}

/** Runs after every change (the board redraws "Your account"). */
export const onConnections = (f: () => void) => void subs.add(f);
