// Local offline replay of the agent-fun/replay/v2 market model, written from scratch
// for tuning this bot on the kit's dev window. It is a dev tool only; the bot never
// imports it and the grader runs its own engine.
//
// Model (from the protocol docs in the kit's SDK):
//  - Constant-product AMM on virtual reserves: price (SOL/token) = vq / vt.
//  - Buy (exact SOL in): fees of protocol+creator bps are taken off the spend, the
//    remainder buys tokens at the curve: tokens = (q-1) * vt / (vq + q - 1).
//  - Sell (exact tokens in): quote = t * vq / (vt + t), fees taken off the quote.
//  - Every order also pays base + priority tx fee, filled or failed (not rejected).
//  - Orders decided on slot s fill at s + latency (2 slots), priced at the reserves
//    then (including our own earlier fills' impact). A fill is rejected when its
//    output is worse than the decision-time quote by more than max_slippage_bps.
//  - Buys on one mint in one reply may spend at most 1% of its real SOL reserve.
//  - At most 5 open positions; a CompleteEvent force-closes the position at final
//    reserves; remaining positions flatten at the end of the data.
//  - 2% of transactions fail (seeded draw): tx fee paid, nothing traded.
//  - No clock, no randomness in the bot path: the failure draw is a seeded hash of
//    (seed, seq, order index), so runs are reproducible.

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import {
  BotState,
  type Batch,
  type Bot,
  type Fill,
  type Hello,
  type Mark,
  type Order,
} from '../vendor/makefun-bot.ts';

const BPS = 10_000n;

// --- small deterministic 64-bit mixer (SplitMix-style) for the seeded fail draw ---
const MASK64 = (1n << 64n) - 1n;
function mix64(z0: bigint): bigint {
  let z = z0 & MASK64;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
  return z ^ (z >> 31n);
}
function drawU64(seed: bigint, ...parts: bigint[]): bigint {
  let h = mix64(seed + 0x9e3779b97f4a7c15n);
  for (const p of parts) h = mix64(h ^ (p & MASK64));
  return h;
}

// --- AMM math (constant product on virtual reserves) ---
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
const feeOf = (amount: bigint, bps: bigint) => ceilDiv(amount * bps, BPS);

interface CurveReserves {
  vq: bigint;
  vt: bigint;
  rq: bigint;
  rt: bigint;
}

function buyTokensOut(spendNet: bigint, s: CurveReserves): bigint {
  if (spendNet <= 1n) return 0n;
  return ((spendNet - 1n) * s.vt) / (s.vq + spendNet - 1n);
}
function buyQuoteInForTokens(t: bigint, s: CurveReserves): bigint {
  return (t * s.vq) / (s.vt - t) + 1n;
}
function sellQuoteOut(t: bigint, s: CurveReserves): bigint {
  return (t * s.vq) / (s.vt + t);
}

export interface Dataset {
  sha256: string;
  events: any[];
  endSlot: number;
  batches: { slot: number; events: any[] }[];
  firstBlockTime: number;
  lastBlockTime: number;
}

export function loadDataset(kitDir: string): Dataset {
  const kitJson = JSON.parse(readFileSync(`${kitDir}/kit.json`, 'utf8'));
  const manifest = JSON.parse(readFileSync(`${kitDir}/dataset/manifest.json`, 'utf8'));
  const { modulus, residue } = manifest.universe.sample;
  const excluded = new Set<string>(manifest.excluded_mints ?? []);
  const members = new Set<string>();
  const events: any[] = [];
  let firstBlockTime = Number.MAX_SAFE_INTEGER;
  let lastBlockTime = 0;
  for (const part of ['part-00000', 'part-00001', 'part-00002']) {
    let raw: string;
    try {
      raw = gunzipSync(readFileSync(`${kitDir}/dataset/events/${part}.ndjson.gz`)).toString('utf8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      if (!line) continue;
      const e = JSON.parse(line);
      if (e.event === 'CreateEvent' && !members.has(e.mint)) {
        const h = BigInt('0x' + createHash('sha256').update(e.mint, 'utf8').digest('hex'));
        if (
          e.quote_mint === '11111111111111111111111111111111' &&
          !e.is_mayhem_mode &&
          !e.is_cashback_enabled &&
          !excluded.has(e.mint) &&
          h % BigInt(modulus) === BigInt(residue)
        ) {
          members.add(e.mint);
        }
      }
      if (members.has(e.mint)) {
        events.push(e);
        if (typeof e.block_time === 'number') {
          if (e.block_time < firstBlockTime) firstBlockTime = e.block_time;
          if (e.block_time > lastBlockTime) lastBlockTime = e.block_time;
        }
      }
    }
  }
  events.sort((a, b) => a.slot - b.slot || (a.chain_seq ?? 0) - (b.chain_seq ?? 0));
  const batches: { slot: number; events: any[] }[] = [];
  for (const e of events) {
    const tail = batches[batches.length - 1];
    if (tail !== undefined && tail.slot === e.slot) tail.events.push(e);
    else batches.push({ slot: e.slot, events: [e] });
  }
  const endSlot = manifest.window?.end_slot ?? events[events.length - 1]?.slot ?? 0;
  return { sha256: kitJson.dataset_sha256, events, endSlot, batches, firstBlockTime, lastBlockTime };
}

export function makeHello(seed: string): Hello {
  return {
    type: 'hello',
    protocol: 'agent-fun/replay/v2',
    seed,
    universe: {
      program: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
      quote: 'SOL',
      mayhem: 'excluded',
      exclude_cashback: true,
      sample: { hash: 'sha256', modulus: 16, residue: 15 },
    },
    capital: { lamports: '10000000000' },
    caps: { max_open_positions: 5, max_order_bps_of_real_reserve: 100, max_orders_per_batch: 16, shorts: false, leverage: false },
    latency_slots: 2,
    fees: {
      protocol_bps_fallback: 95,
      creator_bps_fallback: 30,
      base_fee_lamports: '5000',
      priority_fee_lamports: '100000',
      failed_tx_bps: 200,
    },
  };
}

interface MintRt {
  state: CurveReserves;
  stateSlot: number;
  lastTrade: any | null;
  lastTradeSlot: number;
  complete: boolean;
  // Our own fills' impact on the curve, applied on top of the recorded reserves.
  offQ: bigint;
  offT: bigint;
}

interface Pending {
  order: Order;
  seq: number;
  index: number;
  decidedSlot: number;
  fillSlot: number;
  reject: string | null;
  decision: CurveReserves | null;
}

export interface Trip {
  mint: string;
  open: number;
  close: number;
  pnl: bigint;
}

export interface SimResult {
  netPnl: bigint;
  fills: number;
  mints: number;
  trips: Trip[];
  rejected: number;
  failed: number;
  maxDrawdown: number;
  sharpeHourly: number;
  hourlyReturns: number[];
  rejectReasons: Record<string, number>;
  perMint: Map<string, bigint>;
}

export interface SimOptions {
  failKey?: bigint | null;
  feeMultiplier?: bigint;
}

export function simulate(ds: Dataset, hello: Hello, bot: Bot, opts: SimOptions = {}): SimResult {
  const failKey = opts.failKey === undefined ? drawU64(BigInt(hello.seed), 0x6661696c2d6b6579n) : opts.failKey;
  const mult = opts.feeMultiplier ?? 1n;
  const txFee = (BigInt(hello.fees.base_fee_lamports) + BigInt(hello.fees.priority_fee_lamports)) * mult;
  const latency = hello.latency_slots;
  const caps = hello.caps;
  const mints = new Map<string, MintRt>();
  const pending: Pending[] = [];
  const usedIds = new Set<string>();
  const positions = new Map<string, { tokens: bigint; cost: bigint }>();
  const startCash = BigInt(hello.capital.lamports);
  let cash = startCash;
  let undelivered: Fill[] = [];
  let seq = 0;
  let closeCounter = 0;
  const spent = { seq: -1, byMint: new Map<string, bigint>() };
  let fills = 0;
  let rejected = 0;
  let failed = 0;
  const rejectReasons: Record<string, number> = {};
  const filledMints = new Set<string>();
  const perMint = new Map<string, bigint>();
  const openPnl = new Map<string, { pnl: bigint; open: number }>();
  const trips: Trip[] = [];
  let peak = startCash;
  let maxDd = 0;
  // Hourly equity snapshots (block-time hours since window start) for Sharpe.
  const hourEquity = new Map<number, bigint>();
  const hourOf = (blockTime: number | null, slot: number) =>
    blockTime !== null && blockTime !== undefined
      ? Math.floor((blockTime - ds.firstBlockTime) / 3600)
      : Math.floor((slot - ds.batches[0].slot) / 16800);

  const flow = (mint: string, d: bigint) => {
    perMint.set(mint, (perMint.get(mint) ?? 0n) + d);
    const o = openPnl.get(mint);
    if (o) o.pnl += d;
  };
  const closeTrip = (mint: string, slot: number) => {
    const o = openPnl.get(mint);
    if (!o) return;
    trips.push({ mint, open: o.open, close: slot, pnl: o.pnl });
    openPnl.delete(mint);
  };
  const reserves = (m: MintRt): CurveReserves => {
    // Apply our offset, clamped the same way the engine does: our sells cannot
    // take more tokens than the curve holds, our buys cannot push quote below 0.
    let num = 1n;
    let den = 1n;
    if (m.offT > m.state.rt) {
      num = m.state.rt;
      den = m.offT;
    }
    if (m.offQ < 0n && m.state.rq * den < num * -m.offQ) {
      num = m.state.rq;
      den = -m.offQ;
    }
    const scale = (x: bigint) => (num === den ? x : x >= 0n ? (x * num) / den : -((-x * num) / den));
    const q = scale(m.offQ);
    const t = scale(m.offT);
    return { vq: m.state.vq + q, rq: m.state.rq + q, vt: m.state.vt - t, rt: m.state.rt - t };
  };
  const feesFor = (landing: any | null) =>
    landing !== null && BigInt(landing.fee_basis_points) > 0n
      ? { protocol: BigInt(landing.fee_basis_points) * mult, creator: BigInt(landing.creator_fee_basis_points) * mult }
      : { protocol: BigInt(hello.fees.protocol_bps_fallback) * mult, creator: BigInt(hello.fees.creator_bps_fallback) * mult };
  const impact = (m: MintRt, isBuy: boolean, q: bigint, t: bigint) => {
    if (isBuy) {
      m.offQ += q;
      m.offT += t;
    } else {
      m.offQ -= q;
      m.offT -= t;
    }
  };
  const closeQuote = (m: MintRt, tokens: bigint) => {
    const s = reserves(m);
    const bps = feesFor(m.lastTrade);
    const raw = sellQuoteOut(tokens, s);
    const q = raw > s.rq ? s.rq : raw;
    const proceeds = q - feeOf(q, bps.protocol) - feeOf(q, bps.creator);
    return { q, proceeds, net: proceeds - txFee, abandon: proceeds - txFee <= 0n };
  };
  const equityNow = () => {
    let e = cash;
    for (const [mint, p] of positions) {
      const c = closeQuote(mints.get(mint)!, p.tokens);
      if (!c.abandon) e += c.net;
    }
    return e;
  };
  const pushEquity = (e: bigint) => {
    if (e > peak) peak = e;
    const dd = Number(peak - e) / Number(peak);
    if (dd > maxDd) maxDd = dd;
  };
  const pushFill = (p: Pending, status: Fill['status'], reason: string | null, quote: bigint, tokens: bigint) => {
    if (status === 'rejected') {
      rejected++;
      rejectReasons[reason!] = (rejectReasons[reason!] ?? 0) + 1;
    }
    if (status === 'failed') failed++;
    if (status === 'filled') {
      fills++;
      filledMints.add(p.order.mint);
    }
    undelivered.push({
      client_id: p.order.client_id,
      mint: p.order.mint,
      side: p.order.side,
      status,
      reason: reason as Fill['reason'],
      decided_slot: p.decidedSlot,
      slot: p.fillSlot,
      quote_lamports: quote.toString(),
      token_amount: tokens.toString(),
      fee_lamports: '0',
      tx_fee_lamports: status === 'rejected' ? '0' : txFee.toString(),
      fee_fallback: false,
    });
  };
  const openCount = () => {
    let n = 0;
    for (const p of positions.values()) if (p.tokens > 0n) n++;
    return n;
  };
  const isFailed = (p: Pending) =>
    failKey !== null && drawU64(failKey, 0x6661696c65642d74n, BigInt(p.seq), BigInt(p.index)) % 10_000n < BigInt(hello.fees.failed_tx_bps);

  const resolve = (p: Pending): void => {
    if (p.reject !== null) return pushFill(p, 'rejected', p.reject, 0n, 0n);
    const m = mints.get(p.order.mint)!;
    if (m.complete) return pushFill(p, 'rejected', 'token_complete', 0n, 0n);
    const landing = m.lastTradeSlot === p.fillSlot ? m.lastTrade : null;
    const bps = feesFor(landing);
    const slip = BigInt(p.order.max_slippage_bps);
    const decision = p.decision!;
    const s = reserves(m);
    if (p.order.side === 'sell') {
      const pos = positions.get(p.order.mint);
      const t = BigInt(p.order.token_amount);
      if (pos === undefined || pos.tokens < t) return pushFill(p, 'rejected', 'insufficient_tokens', 0n, 0n);
      const q = sellQuoteOut(t, s);
      if (q > s.rq) return pushFill(p, 'rejected', 'max_order_size', 0n, 0n);
      const proceeds = q - feeOf(q, bps.protocol) - feeOf(q, bps.creator);
      if (proceeds <= 0n) return pushFill(p, 'rejected', 'zero_amount', 0n, 0n);
      const expectedQ = sellQuoteOut(t, decision);
      const expected = expectedQ - feeOf(expectedQ, bps.protocol) - feeOf(expectedQ, bps.creator);
      if (proceeds * BPS < expected * (BPS - slip)) return pushFill(p, 'rejected', 'max_slippage', 0n, 0n);
      if (cash < txFee) return pushFill(p, 'rejected', 'insufficient_cash', 0n, 0n);
      if (isFailed(p)) {
        cash -= txFee;
        flow(p.order.mint, -txFee);
        return pushFill(p, 'failed', null, 0n, 0n);
      }
      cash += proceeds - txFee;
      flow(p.order.mint, proceeds - txFee);
      const removed = pos.tokens === t ? pos.cost : (pos.cost * t) / pos.tokens;
      pos.tokens -= t;
      pos.cost -= removed;
      impact(m, false, q, t);
      if (pos.tokens === 0n) {
        positions.delete(p.order.mint);
        closeTrip(p.order.mint, p.fillSlot);
      }
      return pushFill(p, 'filled', null, proceeds, t);
    }
    const spend = BigInt(p.order.quote_lamports);
    const held = positions.get(p.order.mint);
    if ((held === undefined || held.tokens === 0n) && openCount() >= caps.max_open_positions) {
      return pushFill(p, 'rejected', 'max_open_positions', 0n, 0n);
    }
    if (spent.seq !== p.seq) {
      spent.seq = p.seq;
      spent.byMint.clear();
    }
    const total = (spent.byMint.get(p.order.mint) ?? 0n) + spend;
    if (total * BPS > decision.rq * BigInt(caps.max_order_bps_of_real_reserve)) {
      return pushFill(p, 'rejected', 'max_order_size', 0n, 0n);
    }
    spent.byMint.set(p.order.mint, total);
    const net0 = (spend * BPS) / (BPS + bps.protocol + bps.creator);
    const fee = feeOf(net0, bps.protocol);
    const creatorFee = feeOf(net0, bps.creator);
    const over = net0 + fee + creatorFee > spend ? net0 + fee + creatorFee - spend : 0n;
    const q0 = net0 - over;
    let t = buyTokensOut(q0, s);
    let paid: bigint;
    let q: bigint;
    if (t > s.rt) {
      const tc = s.rt;
      if (tc === 0n) return pushFill(p, 'rejected', 'zero_amount', 0n, 0n);
      q = buyQuoteInForTokens(tc, s);
      t = tc;
      paid = q + feeOf(q, bps.protocol) + feeOf(q, bps.creator);
    } else {
      q = q0;
      paid = q0 + fee + creatorFee;
    }
    if (t === 0n) return pushFill(p, 'rejected', 'zero_amount', 0n, 0n);
    const expected = buyTokensOut(q0, decision);
    if (t * BPS < expected * (BPS - slip)) return pushFill(p, 'rejected', 'max_slippage', 0n, 0n);
    if (cash < spend + txFee) return pushFill(p, 'rejected', 'insufficient_cash', 0n, 0n);
    if (isFailed(p)) {
      cash -= txFee;
      flow(p.order.mint, -txFee);
      return pushFill(p, 'failed', null, 0n, 0n);
    }
    cash -= paid + txFee;
    let pos = held;
    const opening = pos === undefined || pos.tokens === 0n;
    if (pos === undefined) {
      pos = { tokens: 0n, cost: 0n };
      positions.set(p.order.mint, pos);
    }
    if (opening) openPnl.set(p.order.mint, { pnl: 0n, open: p.fillSlot });
    flow(p.order.mint, -(paid + txFee));
    pos.tokens += t;
    pos.cost += paid;
    impact(m, true, q, t);
    return pushFill(p, 'filled', null, paid, t);
  };

  const forceClose = (mint: string, why: string, slot: number) => {
    const pos = positions.get(mint)!;
    const m = mints.get(mint)!;
    const c = closeQuote(m, pos.tokens);
    const n = closeCounter++;
    const kind = c.abandon ? 'writeoff' : why;
    if (!c.abandon) {
      cash += c.net;
      flow(mint, c.net);
      impact(m, false, c.q, pos.tokens);
    }
    undelivered.push({
      client_id: `_${kind}_${n}`,
      mint,
      side: 'sell',
      status: 'filled',
      reason: null,
      decided_slot: slot,
      slot,
      quote_lamports: c.abandon ? '0' : c.proceeds.toString(),
      token_amount: pos.tokens.toString(),
      fee_lamports: '0',
      tx_fee_lamports: c.abandon ? '0' : txFee.toString(),
      fee_fallback: false,
    });
    positions.delete(mint);
    closeTrip(mint, slot);
  };
  const account = () => ({
    cash_lamports: cash.toString(),
    positions: [...positions.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([mint, p]) => ({ mint, token_amount: p.tokens.toString(), cost_lamports: p.cost.toString() })),
  });
  const marks = (): Mark[] => {
    const want = new Set<string>(positions.keys());
    for (const p of pending) if (mints.has(p.order.mint)) want.add(p.order.mint);
    return [...want].sort().map((mint) => {
      const m = mints.get(mint)!;
      const s = reserves(m);
      return {
        mint,
        slot: m.stateSlot,
        virtual_token_reserves: s.vt.toString(),
        virtual_quote_reserves: s.vq.toString(),
        real_token_reserves: s.rt.toString(),
        real_quote_reserves: s.rq.toString(),
      };
    });
  };

  const state = new BotState(hello);
  bot.onHello?.(state);
  for (const b of ds.batches) {
    const x = b.slot;
    while (pending.length > 0 && pending[0]!.fillSlot < x) resolve(pending.shift()!);
    const completed: string[] = [];
    for (const e of b.events) {
      if (e.event === 'CreateEvent') {
        mints.set(e.mint, {
          state: {
            vq: BigInt(e.virtual_quote_reserves),
            vt: BigInt(e.virtual_token_reserves),
            rq: 0n,
            rt: BigInt(e.real_token_reserves),
          },
          stateSlot: x,
          lastTrade: null,
          lastTradeSlot: -1,
          complete: false,
          offQ: 0n,
          offT: 0n,
        });
      } else if (e.event === 'TradeEvent') {
        let m = mints.get(e.mint);
        if (m === undefined) {
          // A trade for a curve whose CreateEvent is outside this slice: seed
          // the curve from the trade's own reserves, as the shim does.
          m = {
            state: { vq: 0n, vt: 0n, rq: 0n, rt: 0n },
            stateSlot: x,
            lastTrade: null,
            lastTradeSlot: -1,
            complete: false,
            offQ: 0n,
            offT: 0n,
          };
          mints.set(e.mint, m);
        }
        m.state = {
          vq: BigInt(e.virtual_quote_reserves),
          vt: BigInt(e.virtual_token_reserves),
          rq: BigInt(e.real_quote_reserves),
          rt: BigInt(e.real_token_reserves),
        };
        m.stateSlot = x;
        m.lastTrade = e;
        m.lastTradeSlot = x;
      } else {
        const m = mints.get(e.mint);
        if (m !== undefined) {
          m.complete = true;
          completed.push(e.mint);
        }
      }
    }
    for (const mint of completed) if (positions.has(mint)) forceClose(mint, 'complete', x);
    while (pending.length > 0 && pending[0]!.fillSlot === x) resolve(pending.shift()!);
    const batch: Batch = { type: 'batch', seq, slot: x, events: b.events, marks: marks(), fills: undelivered, account: account() };
    undelivered = [];
    pushEquity(equityNow());
    const bt = b.events.find((e) => typeof e.block_time === 'number')?.block_time ?? null;
    hourEquity.set(hourOf(bt, x), equityNow());
    state.applyBatch(batch);
    const orders = state.toOrders(bot.onBatch(state, batch) as any);
    state.recordOrders(orders);
    orders.forEach((order, index) => {
      let reject: string | null = null;
      const amount = order.side === 'buy' ? order.quote_lamports : order.token_amount;
      if (index >= caps.max_orders_per_batch) reject = 'max_orders_per_batch';
      else if (usedIds.has(order.client_id)) reject = 'duplicate_client_id';
      else if (amount === '0') reject = 'zero_amount';
      else if (!mints.has(order.mint)) reject = 'not_in_universe';
      usedIds.add(order.client_id);
      const m = mints.get(order.mint);
      pending.push({ order, seq, index, decidedSlot: x, fillSlot: x + latency, reject, decision: m ? reserves(m) : null });
    });
    seq++;
  }
  while (pending.length > 0) {
    const p = pending.shift()!;
    if (p.fillSlot > ds.endSlot) pushFill(p, 'rejected', 'after_end', 0n, 0n);
    else resolve(p);
  }
  for (const mint of [...positions.keys()].sort()) forceClose(mint, 'flatten', ds.endSlot);
  pushEquity(cash);
  hourEquity.set(hourOf(null, ds.endSlot), cash);
  bot.onDone?.(state, { type: 'done', seq, reason: 'end_of_data', account: account() });

  // Hourly Sharpe: mean / std of per-hour equity returns (population std).
  const hours = [...hourEquity.keys()].sort((a, b) => a - b);
  const hourlyReturns: number[] = [];
  for (let i = 1; i < hours.length; i++) {
    const prev = Number(hourEquity.get(hours[i - 1])!);
    const cur = Number(hourEquity.get(hours[i])!);
    if (prev > 0) hourlyReturns.push(cur / prev - 1);
  }
  let sharpeHourly = 0;
  if (hourlyReturns.length >= 2) {
    const mean = hourlyReturns.reduce((a, b) => a + b, 0) / hourlyReturns.length;
    const varr = hourlyReturns.reduce((a, r) => a + (r - mean) ** 2, 0) / hourlyReturns.length;
    const std = Math.sqrt(varr);
    sharpeHourly = std > 0 ? mean / std : 0;
  }
  return {
    netPnl: cash - startCash,
    fills,
    mints: filledMints.size,
    trips,
    rejected,
    failed,
    maxDrawdown: maxDd,
    sharpeHourly,
    hourlyReturns,
    rejectReasons,
    perMint,
  };
}
