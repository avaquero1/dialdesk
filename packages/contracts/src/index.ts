export * from './common.ts';
export * from './look.ts';
export * from './sources.ts';
export * from './catalog.ts';
export * from './widget.ts';
export * from './verdict.ts';
export * from './result.ts';
export * from './bus.ts';
export * from './tools.ts';
export * from './rust.ts';
export * from './endpoint.ts';
export * from './api/accounts.ts';
export * from './api/board.ts';
export * from './api/agent.ts';
export * from './api/runner.ts';
export * from './api/markets.ts';
export * from './api/connections.ts';
export * from './api/models.ts';
export * from './api/audit.ts';
export * from './api/edge.ts';

import type { ServiceName } from './common.ts';
import type { Endpoint } from './endpoint.ts';
import { ACCOUNTS } from './api/accounts.ts';
import { AGENT } from './api/agent.ts';
import { AUDIT } from './api/audit.ts';
import { BOARD } from './api/board.ts';
import { CONNECTIONS } from './api/connections.ts';
import { EDGE } from './api/edge.ts';
import { MARKETS } from './api/markets.ts';
import { MODELS } from './api/models.ts';
import { RUNNER } from './api/runner.ts';

/** Every service's endpoint table. */
export const APIS = {
  edge: EDGE,
  accounts: ACCOUNTS,
  board: BOARD,
  agent: AGENT,
  runner: RUNNER,
  markets: MARKETS,
  connections: CONNECTIONS,
  models: MODELS,
  audit: AUDIT,
} as const satisfies Record<ServiceName, Record<string, Endpoint>>;

/** caller -> the services it calls over HTTP, derived from every endpoint's `callers`. */
export function callGraph(): Record<string, ServiceName[]> {
  const g: Record<string, Set<ServiceName>> = {};
  for (const [svc, table] of Object.entries(APIS) as [ServiceName, Record<string, Endpoint>][]) {
    for (const e of Object.values(table)) {
      for (const c of e.callers) (g[c] ??= new Set()).add(svc);
    }
  }
  // runner calls sandbox-manager (Rust; not in APIS).
  return Object.fromEntries(Object.entries(g).map(([k, v]) => [k, [...v].sort()]));
}
