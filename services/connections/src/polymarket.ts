import { z } from 'zod';
import { getOnlyFetch, type Route } from './getonly.ts';

/**
 * Polymarket positions by public wallet address: Data API v2 (`GET /v2/positions?user=0x…`, no key; v1 was retired
 * on Nov 2). v2 wraps rows in `{ data, pagination }` with snake_case fields (checked against
 * data-api.polymarket.com/v2/openapi.json on 2026-11-07). Same GET-only guard as Kalshi.
 */
export const POLYMARKET_DATA_API = 'https://data-api.polymarket.com';
export const POLYMARKET_ROUTES: Route[] = [{ origin: POLYMARKET_DATA_API, base: '', paths: ['/v2/positions'] }];

export const PolyPosition = z.object({
  slug: z.string(),
  condition_id: z.string().optional(),
  outcome: z.string(),
  outcome_index: z.number().int(),
  current_size: z.number(),
  avg_price: z.number(),
  current_price: z.number().optional(),
  status: z.string().optional(),
});
export type PolyPosition = z.infer<typeof PolyPosition>;
export const PolyPositionsPage = z.object({
  data: z.array(PolyPosition).nullable(),
  pagination: z.object({ has_more: z.boolean(), next_cursor: z.string().nullable().optional() }),
});

export class PolymarketError extends Error {
  name = 'PolymarketError';
  constructor(readonly status: number) {
    super(`polymarket answered ${status}`);
  }
  get retryable() {
    return this.status === 429 || this.status >= 500;
  }
}

export function polymarketClient(o: { fetch?: typeof fetch; timeoutMs?: number } = {}) {
  const send = getOnlyFetch(POLYMARKET_ROUTES, o.fetch ?? fetch);
  return {
    /** Open positions of a wallet, following next_cursor (at most 10 pages of 500). */
    async positions(wallet: string, signal?: AbortSignal): Promise<PolyPosition[]> {
      const out: PolyPosition[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 10; page++) {
        const q = new URLSearchParams({ user: wallet, ...(cursor ? { cursor } : { limit: '500' }) });
        const timeout = AbortSignal.timeout(o.timeoutMs ?? 10_000);
        const res = await send(`${POLYMARKET_DATA_API}/v2/positions?${q}`, {
          headers: { accept: 'application/json' },
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        if (!res.ok) {
          await res.body?.cancel();
          throw new PolymarketError(res.status);
        }
        const p = PolyPositionsPage.parse(await res.json());
        out.push(...(p.data ?? []));
        cursor = p.pagination.next_cursor ?? null;
        if (!p.pagination.has_more || !cursor) break;
      }
      return out;
    },
  };
}
export type PolymarketClient = ReturnType<typeof polymarketClient>;
