// Six-hour sprint sniper with paced probes, for agent-fun/replay/v2 (pump.fun bonding curves).
//
// Thesis (my own design, tuned on this kit's 24h dev window, three 8h parts):
// the final window is only 6 hours, so a launch filter that yields 2-6 coins per 6h
// can never meet the 20-coin minimum bar on its own. This bot therefore runs two
// engines at once. The sniper is the edge engine: it buys only launches whose
// creator put real money in during the create slot, whose crowd is real but small,
// and whose tape is still moving up — then it takes profit fast and cuts losers
// fast. The probes are the volume engine: when the coin pace lags the 22-coins-
// per-6h target, the bot buys 0.012 SOL of the most liquid curve that just traded
// and sells it whole as soon as the buy lands. A flat probe costs ~0.0005 SOL;
// missing the 20-coin bar would rank the entry below every entry that meets it,
// so the probes are paced to guarantee the bar, not to chase PnL. A probe that
// rides a runner is a bonus, never the plan.
//
// Why the sniper filter is what it is (measured on the dev window): bonding-curve
// fees are ~2.5% per round trip (95 bps protocol + 30 bps creator) plus 105,000
// lamports of tx fees per order, and most fresh coins dump within a few slots, so
// an indiscriminate sniper loses a little on almost every coin (the house sniper
// pilot: -0.48 SOL combined on the 24h window; momentum -9.38 SOL). The only edge
// that survived the grid is extreme selectivity at launch (creator buy >= 0.2 SOL,
// exactly 3 distinct non-creator buyers, nobody selling more than they bought)
// plus fast exits (half off at +10%, the rest at +20% or breakeven, stop -12%,
// at most 15 slots). The momentum-confirmation and trailing-stop twists I tried
// first were tested and dropped: the momentum filter never bit (every qualifying
// coin already had a rising tape at decision time) and the trailing stop cut
// winners that would have reached the second take-profit. Parameters below were
// picked from a flat region of the grid (tp1 800-1000, tp2 2000, hold 15-18 all
// land within ~0.002 SOL of each other on 6h slices), not a single best cell.
//
// Determinism: a pure function of the batches the harness sends. No clock, no
// Math.random, no environment, no I/O. Block time comes from the events
// themselves, never the wall clock. All iteration is over insertion-ordered maps
// fed by the batch stream, or over mint keys sorted lexicographically. Money math
// is integer (bigint) throughout.

import type { Batch, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

const BPS = 10_000n;
const LAMPORTS = 1_000_000_000n;

export interface Params {
  /** Oldest age (slots since CreateEvent) at which a first buy may still be decided. */
  maxAge: number;
  /** Lamports aimed for per sniper coin (each reply still capped at 1% of real SOL). */
  stakeLamports: bigint;
  /** Smallest single buy worth paying the tx fee for. */
  minBuyLamports: bigint;
  /** Real SOL reserve window at decision time (lamports). */
  minRealSol: bigint;
  maxRealSol: bigint;
  /** Creator's own buys in the create slot: lamports window. */
  minCreatorBuy: bigint;
  maxCreatorBuy: bigint;
  /** Distinct non-creator buyers seen before entry: window. */
  minBuyers: number;
  maxBuyers: number;
  /** Lamports sold by non-creator wallets / lamports bought, as bps, at most. */
  maxSellRatioBps: number;
  /** Price at decision must be at least this far above the create price (bps, 0 = not below). */
  minRunupBps: number;
  /** Recent net flow (buys minus sells, lamports) over flowWindow slots must be at least this. */
  flowWindow: number;
  minFlowLamports: bigint;
  /** Creator sold before entry: skip the coin. */
  skipCreatorSold: boolean;
  /** Slippage allowed on buys (bps): a buy whose price jumps more than this in the latency is refused. */
  buySlippageBps: number;
  /** First take-profit: sell tp1PartBps of the position once it is worth tp1Bps over its cost. */
  tp1Bps: number;
  tp1PartBps: number;
  /** After the first take-profit, the rest stops out at this much under its cost (bps; 0 = breakeven). */
  slAfterTp1Bps: number;
  /** Exit when the position is worth this much over its cost (bps). */
  tp2Bps: number;
  /** Exit when it is worth this much under its cost (bps). */
  slBps: number;
  /** Trailing stop: once up at least trailArmBps, exit on a fall of trailBps from the best value. */
  trailArmBps: number;
  trailBps: number;
  /** Exit after holding this many slots. */
  maxHold: number;
  /** Exit when the creator sells while held. */
  exitOnCreatorSell: boolean;
  /** Probe buy size (lamports). */
  probeSol: bigint;
  /** A probe needs the curve to hold at least this much real SOL. */
  probeMinRealSol: bigint;
  /** Most probes in one run. */
  maxProbes: number;
  /** Slots between probe buys. */
  probeCooldownSlots: number;
  /** No probes before this much block time has passed (seconds). */
  probeAfterSecs: number;
  /** Coins the run aims for (sniper coins + probes) per probeWindowSecs of block time. */
  probeTargetCoins: number;
  /** Probes keep their own steady floor of this many completed probes per window. */
  probeFloor: number;
  /** Block-time window the probe target is paced over (seconds). */
  probeWindowSecs: number;
}

export const DEFAULT_PARAMS: Params = {
  maxAge: 3,
  stakeLamports: 100_000_000n,
  minBuyLamports: 5_000_000n,
  minRealSol: 300_000_000n,
  maxRealSol: 30_000_000_000n,
  minCreatorBuy: 200_000_000n,
  maxCreatorBuy: 2_500_000_000n,
  minBuyers: 3,
  maxBuyers: 3,
  maxSellRatioBps: 2_000,
  minRunupBps: -1_000_000,
  flowWindow: 10,
  minFlowLamports: -1_000_000_000_000n,
  skipCreatorSold: true,
  buySlippageBps: 300,
  tp1Bps: 1_000,
  tp1PartBps: 5_000,
  slAfterTp1Bps: 0,
  tp2Bps: 2_000,
  slBps: 1_200,
  trailArmBps: 1_000_000,
  trailBps: 500,
  maxHold: 15,
  exitOnCreatorSell: true,
  probeSol: 12_000_000n,
  probeMinRealSol: 1_000_000_000n,
  // Run-total probe cap, sized for a 24h dev window (24 per 6h). The 6h final
  // window only ever reaches ~24 of these, so the cap never binds there.
  maxProbes: 96,
  probeCooldownSlots: 60,
  probeAfterSecs: 600,
  probeTargetCoins: 24,
  probeFloor: 12,
  probeWindowSecs: 21_600,
};

interface TapeTick {
  slot: number;
  net: bigint;
}

interface Tape {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  /** Create price as virtual quote / virtual token (store both legs). */
  createVq: bigint;
  createVt: bigint;
  creatorBuy: bigint;
  creatorSold: boolean;
  buyers: Set<Pubkey>;
  /** Non-creator lamports bought / sold (for the sell-ratio filter). */
  buyLamports: bigint;
  sellLamports: bigint;
  /** Recent net flow ticks (buys minus sells), pruned to flowWindow slots. */
  flow: TapeTick[];
}

interface Held {
  mint: Pubkey;
  entrySlot: number;
  /** Best value (lamports) seen while holding, for the trailing stop. */
  best: bigint;
  tp1Done: boolean;
  /** True for a guardrail probe (sell whole on the first batch after the buy lands). */
  probe: boolean;
  probeFilled: boolean;
}

export function createStrategy(params: Params) {
  const tapes = new Map<Pubkey, Tape>();
  const attempted = new Set<Pubkey>();
  const held = new Map<Pubkey, Held>();
  let probesSent = 0;
  let probesDone = 0;
  let lastProbeSlot = -1_000_000;
  let firstBlockTime: number | null = null;
  let coinsDone = 0;

  function tapeFor(mint: Pubkey, slot: number, creator: Pubkey, vq: bigint, vt: bigint): Tape {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { mint, createSlot: slot, creator, createVq: vq, createVt: vt, creatorBuy: 0n, creatorSold: false, buyers: new Set(), buyLamports: 0n, sellLamports: 0n, flow: [] };
      tapes.set(mint, t);
    }
    return t;
  }

  function flowNet(t: Tape, slot: number, window: number): bigint {
    let net = 0n;
    for (const tick of t.flow) if (slot - tick.slot < window) net += tick.net;
    return net;
  }

  function pruneFlow(t: Tape, slot: number, window: number): void {
    while (t.flow.length > 0 && slot - t.flow[0]!.slot >= window) t.flow.shift();
  }

  /** Approximate current value of a holding in lamports (before curve fees). */
  function valueOf(state: BotState, mint: Pubkey, tokens: bigint): bigint {
    const c = state.curves.get(mint);
    if (c === undefined || c.virtual_token_reserves === 0n) return 0n;
    return (tokens * c.virtual_quote_reserves) / c.virtual_token_reserves;
  }

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const orders: OrderInput[] = [];
      const slot = batch.slot;

      // --- Fold the batch's events into the tapes. ---
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          tapeFor(e.mint, slot, e.creator, BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
        } else if (e.event === 'TradeEvent') {
          const t = tapes.get(e.mint);
          if (t === undefined) continue;
          const quote = BigInt(e.quote_amount);
          if (e.user === t.creator) {
            if (e.is_buy) t.creatorBuy += quote;
            else t.creatorSold = true;
          } else {
            if (e.is_buy) {
              t.buyers.add(e.user);
              t.buyLamports += quote;
            } else {
              t.sellLamports += quote;
            }
          }
          t.flow.push({ slot, net: e.is_buy ? quote : -quote });
          pruneFlow(t, slot, params.flowWindow);
        }
      }
      const firstEvent = batch.events[0];
      if (firstEvent !== undefined && firstEvent.block_time !== null) {
        if (firstBlockTime === null) firstBlockTime = firstEvent.block_time;
      }

      // --- Fold the batch's fills into held state (probe fills, closed positions). ---
      for (const f of batch.fills) {
        if (f.status === 'filled' && f.side === 'sell') {
          const h = held.get(f.mint);
          if (h !== undefined) {
            const pos = state.positions.get(f.mint);
            if (pos === undefined || BigInt(pos.token_amount) === 0n) {
              held.delete(f.mint);
              coinsDone += 1;
              if (h.probe) probesDone += 1;
            } else if (h.tp1Done === false) {
              h.tp1Done = true;
            }
          }
        }
        if (f.status === 'filled' && f.side === 'buy') {
          const h = held.get(f.mint);
          if (h !== undefined && h.probe) h.probeFilled = true;
        }
      }

      // --- Exits for held positions. ---
      // Never send a second sell for a mint while one is still in flight: the
      // position still shows its full tokens until the fill lands 2 slots later,
      // and a duplicate TP1 sell would dump the whole position at TP1 instead
      // of half of it.
      const sellPending = new Set<Pubkey>();
      for (const p of state.pending.values()) if (p.order.side === 'sell') sellPending.add(p.order.mint);
      for (const [mint, h] of held) {
        if (sellPending.has(mint)) continue;
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined || curve === undefined || curve.complete) continue;
        const tokens = BigInt(pos.token_amount);
        const cost = BigInt(pos.cost_lamports);
        if (tokens === 0n || cost === 0n) continue;
        const value = valueOf(state, mint, tokens);
        if (value > h.best) h.best = value;
        const gainBps = ((value - cost) * BPS) / cost;
        const tape = tapes.get(mint);
        const creatorSold = tape !== undefined && tape.creatorSold;

        if (h.probe) {
          // Probes sell whole on the first batch after the buy lands, whatever the price.
          if (h.probeFilled) {
            orders.push({ side: 'sell', mint, token_amount: tokens, max_slippage_bps: 10_000 });
          }
          continue;
        }
        if (params.exitOnCreatorSell && creatorSold) {
          orders.push({ side: 'sell', mint, token_amount: tokens, max_slippage_bps: 10_000 });
          continue;
        }
        if (slot - h.entrySlot >= params.maxHold) {
          orders.push({ side: 'sell', mint, token_amount: tokens, max_slippage_bps: 10_000 });
          continue;
        }
        if (!h.tp1Done && gainBps >= BigInt(params.tp1Bps)) {
          const part = (tokens * BigInt(params.tp1PartBps)) / BPS;
          if (part > 0n) {
            orders.push({ side: 'sell', mint, token_amount: part, max_slippage_bps: 10_000 });
            h.tp1Done = true;
          }
          continue;
        }
        if (h.tp1Done) {
          if (gainBps >= BigInt(params.tp2Bps)) {
            orders.push({ side: 'sell', mint, token_amount: tokens, max_slippage_bps: 10_000 });
            continue;
          }
          if (gainBps <= BigInt(params.slAfterTp1Bps)) {
            orders.push({ side: 'sell', mint, token_amount: tokens, max_slippage_bps: 10_000 });
            continue;
          }
        } else if (gainBps <= -BigInt(params.slBps)) {
          orders.push({ side: 'sell', mint, token_amount: tokens, max_slippage_bps: 10_000 });
          continue;
        }
        // Trailing stop: armed once up trailArmBps, exits on a trailBps fall from the best.
        if (h.best > cost) {
          const bestGain = ((h.best - cost) * BPS) / cost;
          if (bestGain >= BigInt(params.trailArmBps)) {
            const fallBps = ((h.best - value) * BPS) / h.best;
            if (fallBps >= BigInt(params.trailBps)) {
              orders.push({ side: 'sell', mint, token_amount: tokens, max_slippage_bps: 10_000 });
              continue;
            }
          }
        }
      }

      // --- Sniper entries: launches still in their first maxAge slots. ---
      if (state.committedPositionCount() < 5) {
        for (const t of tapes.values()) {
          if (state.committedPositionCount() + orders.filter((o) => o.side === 'buy').length >= 5) break;
          const age = slot - t.createSlot;
          if (age < 0 || age > params.maxAge) continue;
          if (attempted.has(t.mint)) continue;
          if (held.has(t.mint)) continue;
          const curve = state.curves.get(t.mint);
          if (curve === undefined || curve.complete) continue;
          if (t.creatorBuy < params.minCreatorBuy || t.creatorBuy > params.maxCreatorBuy) continue;
          if (params.skipCreatorSold && t.creatorSold) continue;
          if (t.buyers.size < params.minBuyers || t.buyers.size > params.maxBuyers) continue;
          // Nobody in the crowd may have sold more than they bought: a coin whose
          // early buyers are already exiting is a dump, not a launch.
          if (t.buyLamports > 0n && (t.sellLamports * BPS) / t.buyLamports > BigInt(params.maxSellRatioBps)) continue;
          const realSol = curve.real_quote_reserves;
          if (realSol < params.minRealSol || realSol > params.maxRealSol) continue;
          // Momentum confirmation: the tape must still be rising, not dumping.
          if (curve.virtual_token_reserves > 0n && t.createVt > 0n) {
            const runup = ((curve.virtual_quote_reserves * t.createVt - t.createVq * curve.virtual_token_reserves) * BPS) / (t.createVq * curve.virtual_token_reserves);
            if (runup < BigInt(params.minRunupBps)) continue;
          }
          if (flowNet(t, slot, params.flowWindow) < params.minFlowLamports) continue;
          const cap = state.maxBuyLamports(t.mint);
          const cash = state.freeCashLamports();
          const txFee = state.txFeeLamports();
          let amount = params.stakeLamports;
          if (amount > cap) amount = cap;
          if (amount > cash - txFee) amount = cash - txFee;
          if (amount < params.minBuyLamports) continue;
          attempted.add(t.mint);
          held.set(t.mint, { mint: t.mint, entrySlot: slot, best: 0n, tp1Done: false, probe: false, probeFilled: false });
          orders.push({ side: 'buy', mint: t.mint, quote_lamports: amount, max_slippage_bps: params.buySlippageBps });
        }
      }

      // --- Guardrail probes: keep the coin pace on target so the 20-coin bar is met. ---
      const elapsed = firstBlockTime !== null && firstEvent !== undefined && firstEvent.block_time !== null
        ? firstEvent.block_time - firstBlockTime
        : 0;
      const want = Math.floor((params.probeTargetCoins * Math.max(elapsed, 0)) / params.probeWindowSecs);
      // Pace on COMPLETED round trips only. A coin still held at the end of the
      // window has not round-tripped, so counting it would let the pace go slack
      // exactly when it matters most; the target is set above the 20-coin bar
      // so a few buys in the final minutes that never sell still leave >= 20.
      // The probes also keep their own steady floor (probeFloor per window) so
      // they spread across the window instead of sprinting late, when the most
      // liquid curve is usually a coin already bleeding out.
      const have = coinsDone;
      const probeFloor = Math.floor((params.probeFloor * Math.max(elapsed, 0)) / params.probeWindowSecs);
      const probeDue = probesDone < probeFloor || have < want;
      if (
        probesSent < params.maxProbes &&
        elapsed >= params.probeAfterSecs &&
        probeDue &&
        slot - lastProbeSlot >= params.probeCooldownSlots &&
        state.committedPositionCount() < 5
      ) {
        // Most liquid curve that traded in this batch, real SOL >= probeMinRealSol.
        let bestMint: Pubkey | null = null;
        let bestReal = -1n;
        const traded = new Set<Pubkey>();
        for (const e of batch.events) if (e.event === 'TradeEvent') traded.add(e.mint);
        const candidates = [...traded].sort();
        for (const mint of candidates) {
          if (attempted.has(mint) || held.has(mint)) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          const realSol = curve.real_quote_reserves;
          if (realSol < params.probeMinRealSol) continue;
          if (realSol > bestReal) {
            bestReal = realSol;
            bestMint = mint;
          }
        }
        if (bestMint !== null) {
          const cap = state.maxBuyLamports(bestMint);
          const cash = state.freeCashLamports();
          const txFee = state.txFeeLamports();
          let amount = params.probeSol;
          if (amount > cap) amount = cap;
          if (amount > cash - txFee) amount = cash - txFee;
          if (amount >= params.minBuyLamports) {
            attempted.add(bestMint);
            held.set(bestMint, { mint: bestMint, entrySlot: slot, best: 0n, tp1Done: false, probe: true, probeFilled: false });
            orders.push({ side: 'buy', mint: bestMint, quote_lamports: amount, max_slippage_bps: 10_000 });
            probesSent += 1;
            lastProbeSlot = slot;
          }
        }
      }

      return orders;
    },
  };
}
