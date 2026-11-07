/**
 * Compares src/prices.ts with Vultr's public model catalog (GET /v1/models needs no key). Exits 1 on a difference.
 *
 *   npm run prices -w services/models
 */
import { PRICES } from '../src/prices.ts';
import { ROLES } from '../src/roles.ts';

type Pricing = { type: string; cost_usd: string };
type Entry = { id: string; input_modalities?: { type: string; pricing?: Pricing[] }[]; output_modalities?: { type: string; pricing?: Pricing[] }[] };

const base = process.env.MODELS_VULTR_BASE_URL ?? 'https://api.vultrinference.com/v1';
const res = await fetch(`${base}/models`, { headers: { accept: 'application/json' } });
const { data } = (await res.json()) as { data: Entry[] };
const live = new Map(data.map((m) => [m.id, m]));
let bad = 0;
const price = (list: Pricing[] | undefined, type: string) => Number(list?.find((p) => p.type === type)?.cost_usd ?? NaN);
for (const [id, want] of Object.entries(PRICES)) {
  const m = live.get(id);
  if (!m) {
    process.stdout.write(`${id}: not in the catalog\n`);
    bad++;
    continue;
  }
  const input = price(m.input_modalities?.find((x) => x.type === 'text')?.pricing, 'prompt');
  const output = price(m.output_modalities?.find((x) => x.type === 'text')?.pricing, 'completion');
  const same = Math.abs(input - want.input) < 1e-12 && Math.abs(output - want.output) < 1e-12;
  if (!same) bad++;
  process.stdout.write(`${same ? 'ok  ' : 'DIFF'} ${id}: table ${want.input}/${want.output}, live ${input}/${output}\n`);
}
for (const [role, spec] of Object.entries(ROLES))
  for (const m of spec.models)
    if (!live.has(m)) {
      bad++;
      process.stdout.write(`role ${role}: ${m} is not in the catalog\n`);
    }
process.exit(bad ? 1 : 0);
