// Offline backtest of strategy.ts on the kit's dev window with the local engine
// port (tools/sim.ts).
//
//   node tools/backtest.ts <kit dir> ['{"takeProfit":0.12}'] [--trips]
//
// Prints net PnL, hourly Sharpe, fills, coins, drawdown and reject reasons.

import { createStrategy, DEFAULT_PARAMS, type Params } from '../strategy.ts';
import { loadDataset, makeHello, simulate } from './sim.ts';

const kit = process.argv[2];
if (kit === undefined) {
  console.error('usage: node tools/backtest.ts <kit dir> [params json] [--trips]');
  process.exit(2);
}
const overrides = process.argv[3] !== undefined && process.argv[3].startsWith('{') ? (JSON.parse(process.argv[3]) as Partial<Params>) : {};
const ds = loadDataset(kit);
const seed = BigInt('0x' + (await import('node:crypto')).createHash('sha256').update(`agent-fun/seed/v1\0pilot-pumpfun-replay\0dev\0${ds.sha256}`).digest('hex').slice(0, 16)).toString();
const hello = makeHello(seed);
const params: Params = {
  ...DEFAULT_PARAMS,
  ...overrides,
  tierA: { ...DEFAULT_PARAMS.tierA, ...(overrides.tierA ?? {}) },
  tierB: { ...DEFAULT_PARAMS.tierB, ...(overrides.tierB ?? {}) },
};
const r = simulate(ds, hello, createStrategy(params));
const sol = (x: bigint) => (Number(x) / 1e9).toFixed(4);
const wins = r.trips.filter((t) => t.pnl > 0n).length;
console.log(
  `net ${sol(r.netPnl)} SOL  sharpe/h ${r.sharpeHourly.toFixed(4)}  fills ${r.fills}  coins ${r.mints}  trips ${r.trips.length}  wins ${wins} (${r.trips.length ? ((100 * wins) / r.trips.length).toFixed(1) : '0'}%)  dd ${(100 * r.maxDrawdown).toFixed(2)}%  rejected ${r.rejected} ${JSON.stringify(r.rejectReasons)}  failed ${r.failed}`,
);
console.log(`hourly returns: [${r.hourlyReturns.map((x) => (100 * x).toFixed(2)).join(', ')}]`);
const noFail = simulate(ds, hello, createStrategy(params), { failKey: null });
const twoX = simulate(ds, hello, createStrategy(params), { feeMultiplier: 2n });
console.log(`without failed txs ${sol(noFail.netPnl)} SOL  at 2x fees ${sol(twoX.netPnl)} SOL`);
if (process.argv.includes('--trips')) {
  for (const t of r.trips) console.log(t.mint.slice(0, 8), 'open', t.open, 'len', t.close - t.open, 'pnl', sol(t.pnl));
}
