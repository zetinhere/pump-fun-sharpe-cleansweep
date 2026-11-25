// CleanSweep v2 — a two-tier early-flow scalper for the pump.fun replay.
//
// What the dev data says (24 h, ~1,300 coins, analysed before writing this):
//  - The median coin peaks ~21 slots (~5 s) after creation and lives ~10 min.
//    By the time a 20-trade momentum window confirms, the move is over.
//  - Only ~77 coins in 24 h ever reach 2 SOL of real reserves. Of those, the
//    ones already up >15% from their create price keep running: ~50% win rate
//    at TP 20% / SL 8%, ~+4% mean per trade after costs. Weaker coins revert.
//  - So the money is in a small number of strong early runners, while the
//    20-coin guardrail needs breadth. Two tiers solve both:
//      Tier A (alpha): strict — real reserves >= 2 SOL, up >= 12% from create,
//        young (<= 600 slots), >= 5 distinct buyers, strong net inflow.
//        Stake 0.25 SOL, TP 20%, SL 8%, trailing stop armed at 10%.
//      Tier B (breadth): loose — reserves >= 1.15 SOL, any modest rise, young.
//        Stake 0.03 SOL, TP 8%, SL 4%, short hold. Roughly breakeven, clears
//        the guardrail cheaply.
//  - Guardrail probes (0.02 SOL, flipped next batch) fire only when the
//    distinct-mint pace lags the target, as a backstop.
//
// Fees dominate: ~1.25% per leg plus a 105,000-lamport tx fee per order, so a
// round trip costs ~2.5%. Tier A needs a real move ahead of it; Tier B needs
// to be small enough that its bleed is rounding error.
//
// Deterministic by construction: no clock, no randomness, iteration only over
// insertion-ordered maps fed by the batch stream.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface TierParams {
  /** Real SOL reserves at entry, lower bound. */
  minRqSol: number;
  /** Real SOL reserves at entry, upper bound. */
  maxRqSol: number;
  /** Price now over create price, minus 1: lower bound. */
  minUp: number;
  /** Same, upper bound: skip coins that already ran too far. */
  maxUp: number;
  /** Slots since CreateEvent before an entry is allowed. */
  minAge: number;
  /** Slots since CreateEvent after which no new entry is allowed. */
  maxAge: number;
  /** Distinct buying wallets in the entry window. */
  minBuyers: number;
  /** Net buy SOL (buys minus sells) over the entry window. */
  minNetSol: number;
  /** SOL to put into one position in total. */
  stakeSol: number;
  /** Exits. */
  takeProfit: number;
  stopLoss: number;
  trail: number;
  /** Trailing stop arms once value reached cost * (1 + trailArm). */
  trailArm: number;
  /** Exit after this many slots held. */
  maxHold: number;
}

export interface Params {
  /** Trades kept per curve tape. */
  tapeLen: number;
  /** Price snapshots kept per curve. */
  priceLen: number;
  /** Entry window in slots (~0.214 s per slot on this chain). */
  windowSlots: number;
  /** Trades looked at for the entry signal. */
  windowTrades: number;
  /** Buy trades in the entry window (both tiers). */
  minBuys: number;
  /** Largest single wallet's share of the window's buy SOL. */
  maxBuyerShare: number;
  /** Smallest buy worth sending. */
  minBuySol: number;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Exit when net SOL over the last fadeTrades trades falls below -fadeNetSol. */
  fadeTrades: number;
  fadeNetSol: number;
  /** Exit on any single recorded sell of at least this many SOL. */
  bigSellSol: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** Pyramid Tier A into strength, up to its stake. */
  pyramid: boolean;
  /** Price rise over entry before a pyramid add is allowed. */
  pyramidUp: number;
  /** Guardrail pacing: probe buys to keep distinct-mint pace on target. */
  probeSol: number;
  /** Target distinct mints per hour of block time; probes fire when behind. */
  probePacePerHour: number;
  /** Slots after first crossing minRqSol during which a Tier A entry is allowed. */
  crossWindowA: number;
  /** Same for Tier B. */
  crossWindowB: number;
  /** Minimum slots after first crossing minRqSol before a Tier A entry. */
  minCrossAgeA: number;
  /** Same for Tier B. */
  minCrossAgeB: number;
  /** Largest single trade's share of the window's buy SOL (bundler filter). */
  maxTradeShare: number;
  tierA: TierParams;
  tierB: TierParams;
}

export const DEFAULT_PARAMS: Params = {
  tapeLen: 48,
  priceLen: 64,
  windowSlots: 1200,
  windowTrades: 8,
  minBuys: 5,
  maxBuyerShare: 0.5,
  minBuySol: 0.01,
  buySlipBps: 1000,
  fadeTrades: 12,
  fadeNetSol: 0.5,
  bigSellSol: 1.5,
  cooldown: 1200,
  maxEntries: 2,
  pyramid: true,
  pyramidUp: 0.05,
  probeSol: 0.02,
  probePacePerHour: 4,
  crossWindowA: 150,
  crossWindowB: 600,
  minCrossAgeA: 30,
  minCrossAgeB: 0,
  maxTradeShare: 0.4,
  tierA: {
    minRqSol: 2.0,
    maxRqSol: 120,
    minUp: 0.12,
    maxUp: 0.6,
    minAge: 0,
    maxAge: 600,
    minBuyers: 5,
    minNetSol: 0.5,
    stakeSol: 0.25,
    takeProfit: 0.2,
    stopLoss: 0.08,
    trail: 0.05,
    trailArm: 0.1,
    maxHold: 6000,
  },
  tierB: {
    minRqSol: 1.15,
    maxRqSol: 120,
    minUp: 0.02,
    maxUp: 0.6,
    minAge: 0,
    maxAge: 1800,
    minBuyers: 4,
    minNetSol: 0.1,
    stakeSol: 0.03,
    takeProfit: 0.08,
    stopLoss: 0.04,
    trail: 0.04,
    trailArm: 0.06,
    maxHold: 1200,
  },
};

const LAMPORTS_PER_SOL = 1_000_000_000;

interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
}

interface PricePoint {
  slot: number;
  price: number;
}

interface CurveTape {
  mint: Pubkey;
  createdSlot: number | null;
  createPrice: number;
  /** First slot the curve's real SOL reserves reached >= tierA.minRqSol. */
  crossSlotA: number | null;
  /** First slot the curve's real SOL reserves reached >= tierB.minRqSol. */
  crossSlotB: number | null;
  trades: TapeTrade[];
  prices: PricePoint[];
}

interface Position {
  mint: Pubkey;
  tier: 'A' | 'B';
  probe: boolean;
  openedSlot: number;
  investedSol: number;
  peakRatio: number;
  lastBuyPrice: number;
}

export function createStrategy(params: Params): Bot {
  const tapes = new Map<Pubkey, CurveTape>();
  const positions = new Map<Pubkey, Position>();
  const cooldownUntil = new Map<Pubkey, number>();
  const entriesPerMint = new Map<Pubkey, number>();
  const filledMints = new Set<Pubkey>();
  // Probes waiting to be sold as soon as they land.
  const probeSellAt = new Map<Pubkey, number>();
  // Mints with a sell already in flight: never send a second sell for them.
  const pendingSell = new Set<Pubkey>();
  // Exit-reason counts, printed to stderr at the end for tuning.
  const exitReasons: Record<string, number> = {};
  let firstBlockTime = -1;
  // Client ids we assign to buys, so a fill can be traced back to its tier:
  // a<n> Tier A entry/pyramid, b<n> Tier B entry, p<n> probe.
  let nextCid = 1;

  const priceOf = (vq: bigint, vt: bigint): number => (vt === 0n ? 0 : Number(vq) / Number(vt));

  const tapeFor = (mint: Pubkey): CurveTape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { mint, createdSlot: null, createPrice: 0, crossSlotA: null, crossSlotB: null, trades: [], prices: [] };
      tapes.set(mint, t);
    }
    return t;
  };

  const recordTrade = (mint: Pubkey, slot: number, isBuy: boolean, solLamports: bigint, user: string, vq: bigint, vt: bigint) => {
    const t = tapeFor(mint);
    t.trades.push({ slot, buy: isBuy, sol: Number(solLamports) / LAMPORTS_PER_SOL, user });
    if (t.trades.length > params.tapeLen) t.trades.splice(0, t.trades.length - params.tapeLen);
    t.prices.push({ slot, price: priceOf(vq, vt) });
    if (t.prices.length > params.priceLen) t.prices.splice(0, t.prices.length - params.priceLen);
  };

  // Net SOL and buyer stats over the tape's trades inside [slot - windowSlots, slot].
  const windowStats = (t: CurveTape, slot: number) => {
    const from = slot - params.windowSlots;
    let net = 0;
    let buys = 0;
    let buySol = 0;
    const buyers = new Map<string, number>();
    let high = 0;
    let n = 0;
    for (const tr of t.trades) {
      if (tr.slot < from) continue;
      n++;
      if (tr.buy) {
        buys++;
        buySol += tr.sol;
        net += tr.sol;
        buyers.set(tr.user, (buyers.get(tr.user) ?? 0) + tr.sol);
      } else {
        net -= tr.sol;
      }
    }
    for (const p of t.prices) {
      if (p.slot < from) continue;
      if (p.price > high) high = p.price;
    }
    const recent = t.trades.filter((tr) => tr.slot >= from);
    const half = Math.floor(recent.length / 2);
    let netOld = 0;
    let netNew = 0;
    let maxTrade = 0;
    recent.forEach((tr, i) => {
      const d = tr.buy ? tr.sol : -tr.sol;
      if (i < half) netOld += d;
      else netNew += d;
      if (tr.buy && tr.sol > maxTrade) maxTrade = tr.sol;
    });
    let topShare = 0;
    for (const v of buyers.values()) if (buySol > 0 && v / buySol > topShare) topShare = v / buySol;
    return { n, net, buys, buySol, buyers: buyers.size, high, netOld, netNew, topShare, maxTradeShare: buySol > 0 ? maxTrade / buySol : 0 };
  };

  // Returns [tier, sizeSol] when the curve qualifies, else null. Tier A first.
  const entrySignal = (state: BotState, mint: Pubkey, slot: number): ['A' | 'B', number] | null => {
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) return null;
    const t = tapes.get(mint);
    if (t === undefined || t.createdSlot === null || t.createPrice <= 0) return null;
    if (positions.has(mint)) return null;
    if (cooldownUntil.has(mint) && slot < cooldownUntil.get(mint)!) return null;
    if ((entriesPerMint.get(mint) ?? 0) >= params.maxEntries) return null;
    const age = slot - t.createdSlot;
    const rqSol = Number(curve.real_quote_reserves) / LAMPORTS_PER_SOL;
    const priceNow = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
    if (priceNow <= 0) return null;
    const up = priceNow / t.createPrice - 1;
    const s = windowStats(t, slot);
    if (s.n < params.windowTrades) return null;
    if (s.buys < params.minBuys) return null;
    if (s.topShare > params.maxBuyerShare) return null;
    if (s.maxTradeShare > params.maxTradeShare) return null;
    if (s.netNew < s.netOld) return null; // flow must still be accelerating
    for (const tier of ['A', 'B'] as const) {
      const tp = tier === 'A' ? params.tierA : params.tierB;
      if (age < tp.minAge || age > tp.maxAge) continue;
      // Enter only shortly after the curve first reached this tier's reserve
      // size: that is when fresh money is arriving, not on a later local pump.
      // But not in the very first slots after crossing: the initial spike is
      // mostly the launch bundle dumping. Wait for the dust to settle.
      const cross = tier === 'A' ? t.crossSlotA : t.crossSlotB;
      const crossWindow = tier === 'A' ? params.crossWindowA : params.crossWindowB;
      const minCrossAge = tier === 'A' ? params.minCrossAgeA : params.minCrossAgeB;
      if (cross === null || slot - cross > crossWindow || slot - cross < minCrossAge) continue;
      if (rqSol < tp.minRqSol || rqSol > tp.maxRqSol) continue;
      if (up < tp.minUp || up > tp.maxUp) continue;
      if (s.buyers < tp.minBuyers) continue;
      if (s.net < tp.minNetSol) continue;
      if (s.high > 0 && priceNow < 0.85 * s.high) continue;
      // Size: the smaller of the tier stake and 0.9% of real reserves (the 1% cap).
      const size = Math.min(tp.stakeSol, 0.009 * rqSol);
      if (size < params.minBuySol) continue;
      return [tier, size];
    }
    return null;
  };

  const tierOf = (pos: Position): TierParams => (pos.tier === 'A' ? params.tierA : params.tierB);

  const valueRatio = (state: BotState, pos: Position): number => {
    const curve = state.curves.get(pos.mint);
    if (curve === undefined) return 1;
    const holding = state.positions.get(pos.mint);
    if (holding === undefined || holding.token_amount === 0n) return 1;
    const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
    const valueSol = (Number(holding.token_amount) * price) / LAMPORTS_PER_SOL;
    const costSol = Number(holding.cost_lamports) / LAMPORTS_PER_SOL;
    if (costSol <= 0) return 1;
    return valueSol / costSol;
  };

  const shouldExit = (state: BotState, pos: Position, slot: number): string | null => {
    const tp = tierOf(pos);
    const ratio = valueRatio(state, pos);
    if (ratio >= 1 + tp.takeProfit) return 'tp';
    if (ratio <= 1 - tp.stopLoss) return 'sl';
    if (ratio > pos.peakRatio) pos.peakRatio = ratio;
    if (pos.peakRatio >= 1 + tp.trailArm && ratio <= pos.peakRatio * (1 - tp.trail)) return 'trail';
    if (slot - pos.openedSlot >= tp.maxHold) return 'time';
    const t = tapes.get(pos.mint);
    if (t !== undefined) {
      // Fade: net SOL over the last fadeTrades trades.
      const recent = t.trades.slice(-params.fadeTrades);
      let net = 0;
      for (const tr of recent) net += tr.buy ? tr.sol : -tr.sol;
      if (recent.length >= params.fadeTrades && net < -params.fadeNetSol) return 'fade';
      // One big sell in this batch's tape tail.
      for (const tr of t.trades) {
        if (tr.slot === slot && !tr.buy && tr.sol >= params.bigSellSol) return 'bigsell';
      }
    }
    return null;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const slot = batch.slot;
      const orders: OrderInput[] = [];

      // Fold this batch's events into the tapes.
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          const t = tapeFor(e.mint);
          t.createdSlot = e.slot;
          t.createPrice = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
          t.prices.push({ slot, price: t.createPrice });
        } else if (e.event === 'TradeEvent') {
          if (typeof e.block_time === 'number' && firstBlockTime < 0) firstBlockTime = e.block_time;
          recordTrade(
            e.mint,
            slot,
            e.is_buy,
            BigInt(e.sol_amount),
            e.user,
            BigInt(e.virtual_sol_reserves),
            BigInt(e.virtual_token_reserves),
          );
          // Record the first slot each reserve threshold is reached.
          const t = tapes.get(e.mint)!;
          const rqSol = Number(e.real_sol_reserves) / LAMPORTS_PER_SOL;
          if (t.crossSlotB === null && rqSol >= params.tierB.minRqSol) t.crossSlotB = slot;
          if (t.crossSlotA === null && rqSol >= params.tierA.minRqSol) t.crossSlotA = slot;
        }
      }

      // Sync positions with the account: record fills, track new holdings, drop closed ones.
      for (const f of batch.fills) {
        if (f.status === 'filled' && f.side === 'sell') pendingSell.delete(f.mint);
        if (f.status === 'filled' && f.side === 'buy') {
          filledMints.add(f.mint);
          const holding = state.positions.get(f.mint);
          if (holding !== undefined) {
            let pos = positions.get(f.mint);
            if (pos === undefined) {
              const curve = state.curves.get(f.mint);
              const price = curve === undefined ? 0 : priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
              // Tier is recovered from the client_id the buy was sent with.
              const probe = f.client_id.startsWith('p');
              const tier: 'A' | 'B' = f.client_id.startsWith('a') ? 'A' : 'B';
              pos = {
                mint: f.mint,
                tier,
                probe,
                openedSlot: slot,
                investedSol: Number(f.quote_lamports) / LAMPORTS_PER_SOL,
                peakRatio: 1,
                lastBuyPrice: price,
              };
              positions.set(f.mint, pos);
              entriesPerMint.set(f.mint, (entriesPerMint.get(f.mint) ?? 0) + 1);
            } else {
              pos.investedSol += Number(f.quote_lamports) / LAMPORTS_PER_SOL;
              const curve = state.curves.get(f.mint);
              if (curve !== undefined) pos.lastBuyPrice = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
            }
          }
        }
      }
      for (const mint of [...positions.keys()]) {
        if (!state.positions.has(mint)) {
          positions.delete(mint);
          cooldownUntil.set(mint, slot + params.cooldown);
        }
      }

      // Exits first: free slots and lock in results before new entries.
      const exiting = new Set<Pubkey>();
      for (const pos of [...positions.values()]) {
        const holding = state.positions.get(pos.mint);
        if (holding === undefined) continue;
        if (pos.probe) continue; // probeSellAt flips probes, not the exit rules
        if (pendingSell.has(pos.mint)) continue;
        const reason = shouldExit(state, pos, slot);
        if (reason !== null) {
          exiting.add(pos.mint);
          pendingSell.add(pos.mint);
          exitReasons[`${pos.tier}:${reason}`] = (exitReasons[`${pos.tier}:${reason}`] ?? 0) + 1;
          orders.push({
            side: 'sell',
            mint: pos.mint,
            token_amount: holding.token_amount,
            max_slippage_bps: 10000,
          });
        }
      }
      // Probes bought earlier: sell as soon as they land.
      for (const [mint, atSlot] of [...probeSellAt.entries()]) {
        const holding = state.positions.get(mint);
        if (holding !== undefined && slot >= atSlot && !pendingSell.has(mint)) {
          pendingSell.add(mint);
          exitReasons['probe'] = (exitReasons['probe'] ?? 0) + 1;
          orders.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: 10000 });
          probeSellAt.delete(mint);
        } else if (holding === undefined) {
          probeSellAt.delete(mint);
        }
      }

      // Pyramid Tier A into strength while the entry signal still holds.
      if (params.pyramid) {
        for (const pos of [...positions.values()]) {
          if (pos.tier !== 'A' || exiting.has(pos.mint)) continue;
          const holding = state.positions.get(pos.mint);
          if (holding === undefined) continue;
          const tp = params.tierA;
          if (pos.investedSol >= tp.stakeSol - 1e-9) continue;
          const curve = state.curves.get(pos.mint);
          if (curve === undefined || curve.complete) continue;
          const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
          if (pos.lastBuyPrice > 0 && price < pos.lastBuyPrice * (1 + params.pyramidUp)) continue;
          const t = tapes.get(pos.mint);
          if (t === undefined) continue;
          const s = windowStats(t, slot);
          if (s.net < tp.minNetSol) continue;
          const rqSol = Number(curve.real_quote_reserves) / LAMPORTS_PER_SOL;
          const add = Math.min(tp.stakeSol - pos.investedSol, 0.009 * rqSol);
          if (add < params.minBuySol) continue;
          if (state.freeCashLamports() < BigInt(Math.floor(add * LAMPORTS_PER_SOL)) + state.txFeeLamports()) continue;
          orders.push({
            side: 'buy',
            client_id: `a${nextCid++}`,
            mint: pos.mint,
            quote_lamports: BigInt(Math.floor(add * LAMPORTS_PER_SOL)),
            max_slippage_bps: params.buySlipBps,
          });
          pos.investedSol += add;
        }
      }

      // New entries: only mints that traded in this batch, Tier A first.
      if (state.committedPositionCount() < state.hello.caps.max_open_positions) {
        const candidates: { mint: Pubkey; tier: 'A' | 'B'; size: number; net: number }[] = [];
        const seen = new Set<Pubkey>();
        for (const e of batch.events) {
          if (e.event !== 'TradeEvent') continue;
          if (seen.has(e.mint)) continue;
          seen.add(e.mint);
          const sig = entrySignal(state, e.mint, slot);
          if (sig === null) continue;
          const t = tapes.get(e.mint)!;
          const s = windowStats(t, slot);
          candidates.push({ mint: e.mint, tier: sig[0], size: sig[1], net: s.net });
        }
        candidates.sort((a, b) => (a.tier === b.tier ? b.net - a.net : a.tier === 'A' ? -1 : 1));
        let freeCash = state.freeCashLamports();
        for (const c of candidates) {
          if (state.committedPositionCount() + orders.filter((o) => o.side === 'buy').length >= state.hello.caps.max_open_positions) break;
          const spend = BigInt(Math.floor(c.size * LAMPORTS_PER_SOL));
          if (freeCash < spend + state.txFeeLamports()) continue;
          // Keep a cash buffer so exits can always pay their tx fee.
          if (freeCash - spend < 2n * state.txFeeLamports()) continue;
          orders.push({
            side: 'buy',
            client_id: `${c.tier === 'A' ? 'a' : 'b'}${nextCid++}`,
            mint: c.mint,
            quote_lamports: spend,
            max_slippage_bps: params.buySlipBps,
          });
          freeCash -= spend + state.txFeeLamports();
          if (orders.length >= state.hello.caps.max_orders_per_batch) break;
        }
      }

      // Guardrail pacing: if distinct-mint pace lags the target, probe a liquid
      // curve with recent buy flow and flip it next batch. Probes are tiny and
      // only fire when genuinely behind, so they cost almost nothing.
      if (firstBlockTime > 0 && batch.events.length > 0) {
        const lastEvent = batch.events[batch.events.length - 1];
        if (typeof lastEvent.block_time === 'number') {
          const hours = Math.max(1, (lastEvent.block_time - firstBlockTime) / 3600);
          const target = Math.floor(params.probePacePerHour * hours);
          if (filledMints.size < target && state.committedPositionCount() < state.hello.caps.max_open_positions) {
            let best: { mint: Pubkey; rq: number } | null = null;
            for (const e of batch.events) {
              if (e.event !== 'TradeEvent' || !e.is_buy) continue;
              const curve = state.curves.get(e.mint);
              if (curve === undefined || curve.complete || positions.has(e.mint)) continue;
              const rq = Number(curve.real_quote_reserves) / LAMPORTS_PER_SOL;
              if (rq < 5 || rq > 100) continue;
              if (best === null || rq > best.rq) best = { mint: e.mint, rq };
            }
            if (best !== null) {
              const spend = BigInt(Math.floor(params.probeSol * LAMPORTS_PER_SOL));
              if (state.freeCashLamports() > spend + 2n * state.txFeeLamports()) {
                orders.push({
                  side: 'buy',
                  client_id: `p${nextCid++}`,
                  mint: best.mint,
                  quote_lamports: spend,
                  max_slippage_bps: params.buySlipBps,
                });
                probeSellAt.set(best.mint, slot + 4);
              }
            }
          }
        }
      }

      return orders;
    },

    onDone() {
      console.error(`[cleansweep] exits by reason: ${JSON.stringify(exitReasons)}`);
    },
  };
}
