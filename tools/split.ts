// Split-sample check: run the strategy on the first and second halves of the
// dev window separately, to see whether the tuned params hold up out of sample.
import { createHash } from 'node:crypto';
import { createStrategy, DEFAULT_PARAMS, type Params } from '../strategy.ts';
import { loadDataset, makeHello, simulate, type Dataset } from './sim.ts';

const kit = process.argv[2];
if (kit === undefined) {
  console.error('usage: node tools/split.ts <kit dir> [params json]');
  process.exit(2);
}
const overrides = process.argv[3] !== undefined && process.argv[3].startsWith('{') ? (JSON.parse(process.argv[3]) as Partial<Params>) : {};
const params: Params = {
  ...DEFAULT_PARAMS,
  ...overrides,
  tierA: { ...DEFAULT_PARAMS.tierA, ...(overrides.tierA ?? {}) },
  tierB: { ...DEFAULT_PARAMS.tierB, ...(overrides.tierB ?? {}) },
};
const ds = loadDataset(kit);
const mid = ds.batches[Math.floor(ds.batches.length / 2)].slot;
const sol = (x: bigint) => Number(x) / 1e9;
for (const [label, from, to] of [
  ['first-half', -1, mid],
  ['second-half', mid, Number.MAX_SAFE_INTEGER],
] as const) {
  const sub: Dataset = {
    ...ds,
    batches: ds.batches.filter((b) => b.slot > from && b.slot <= to),
    events: ds.events.filter((e) => e.slot > from && e.slot <= to),
  };
  const seed = BigInt('0x' + createHash('sha256').update(`agent-fun/seed/v1\0pilot-pumpfun-replay\0dev\0${ds.sha256}`).digest('hex').slice(0, 16)).toString();
  const r = simulate(sub, makeHello(seed), createStrategy(params));
  const wins = r.trips.filter((t) => t.pnl > 0n).length;
  console.log(
    `${label}: net ${sol(r.netPnl).toFixed(3)}  sharpe ${r.sharpeHourly.toFixed(3)}  trips ${r.trips.length}  coins ${r.mints}  win% ${r.trips.length ? ((100 * wins) / r.trips.length).toFixed(1) : '0'}  dd ${(100 * r.maxDrawdown).toFixed(1)}%`,
  );
}
