// Parameter sweep: loads the dev dataset once, runs many param sets, prints a table.
// Usage: node tools/sweep.ts <kit dir> [sets.json path]
// sets.json: array of {name, params} objects. Defaults to a built-in grid.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createStrategy, DEFAULT_PARAMS, type Params } from '../strategy.ts';
import { loadDataset, makeHello, simulate } from './sim.ts';

const kit = process.argv[2];
if (kit === undefined) {
  console.error('usage: node tools/sweep.ts <kit dir> [sets.json]');
  process.exit(2);
}
const ds = loadDataset(kit);
const seed = BigInt('0x' + createHash('sha256').update(`agent-fun/seed/v1\0pilot-pumpfun-replay\0dev\0${ds.sha256}`).digest('hex').slice(0, 16)).toString();
const hello = makeHello(seed);

interface SetDef {
  name: string;
  params: Partial<Params>;
}
let sets: SetDef[];
if (process.argv[3] !== undefined) {
  sets = JSON.parse(readFileSync(process.argv[3], 'utf8'));
} else {
  sets = [{ name: 'base', params: {} }];
}

const sol = (x: bigint) => Number(x) / 1e9;
for (const s of sets) {
  const params: Params = {
    ...DEFAULT_PARAMS,
    ...s.params,
    tierA: { ...DEFAULT_PARAMS.tierA, ...(s.params.tierA ?? {}) },
    tierB: { ...DEFAULT_PARAMS.tierB, ...(s.params.tierB ?? {}) },
  };
  const r = simulate(ds, hello, createStrategy(params), { failKey: null });
  const wins = r.trips.filter((t) => t.pnl > 0n).length;
  const wr = r.trips.length ? (100 * wins) / r.trips.length : 0;
  console.log(
    `${s.name.padEnd(28)} net ${sol(r.netPnl).toFixed(3)}  sharpe ${r.sharpeHourly.toFixed(3)}  trips ${r.trips.length}  coins ${r.mints}  win% ${wr.toFixed(1)}  dd ${(100 * r.maxDrawdown).toFixed(1)}%  fills ${r.fills}`,
  );
}
