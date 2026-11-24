# u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Siksuk72/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Siksuk72/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

Six-hour sprint sniper with paced probes: a selective launch sniper plus a guardrail probe engine that guarantees the 20-coin minimum bar, for make.fun's "Pump.fun Paper Sprint: Any Bot Can Win" bounty ($2 winner-takes-all, paper trading only, no real money).

## Strategy

Two engines, one goal: finish the 6-hour final window with a positive net PnL and at least 20 distinct coins round-tripped.

**Sniper (the edge).** Buys only launches that pass all of these, decided within 3 slots of creation:
- creator bought 0.2–2.5 SOL of their own coin in the create slot (real skin in the game);
- exactly 3 distinct non-creator buyers so far (a real crowd, not a bot swarm);
- nobody in the crowd has sold more than they bought (sell/bought ratio ≤ 2000 bps);
- real SOL reserves 0.3–30 SOL; creator has not sold; buy capped at 1% of real reserves and 0.1 SOL stake.
- Exits: sell half at +10%, the rest at +20% or breakeven after the first take-profit, stop-loss −12%, at most 15 slots held, out immediately if the creator sells. Buys refuse more than 300 bps of slippage in the 2-slot latency.

**Probes (the guardrail).** When completed round trips lag the pace of 24 coins per 6 hours, the bot buys 0.012 SOL of the most liquid curve that just traded (real SOL ≥ 1) and sells it whole as soon as the buy lands. A flat probe costs ~0.0005 SOL in fees; missing the 20-coin bar would rank the entry below every entry that meets it, so the probes are paced to guarantee the bar, not to chase PnL. Probes keep their own steady floor of 12 per 6 hours so they spread across the window instead of sprinting late, and the pace counts completed round trips only — a coin still held at the end of the window has not round-tripped.

**What did not survive testing.** A momentum-confirmation filter (price still rising at decision time) never bit — every qualifying coin already had a rising tape. A trailing stop cut winners that would have reached the second take-profit. Both were tested on the dev window and dropped; the parameters below come from a flat region of the grid (TP1 800–1000 bps, TP2 2000 bps, hold 15–18 slots all land within ~0.002 SOL of each other on 6-hour slices), not a single best cell.

**Determinism.** Pure function of the batches the harness sends: no clock, no randomness, no environment, no I/O. Block time comes from the events themselves. Money math is integer (bigint) throughout. Two runs over identical input produce byte-identical action logs (verified locally and by `grade-local`'s L1 regrade).

## Results (dev window, `src-calib`, 24 h, 128,058 events)

Local simulator, three 8-hour parts, 6-hour slices (the final window is 6 hours):

| slice | net PnL | coins | max drawdown |
| --- | --- | --- | --- |
| part 0, first 6 h | +0.0271 SOL | 25 | 0.0010 SOL |
| part 1, first 6 h | −0.0101 SOL | 29 | 0.0038 SOL |
| part 2, first 6 h | −0.0264 SOL | 21 | 0.0026 SOL |

`grade-local --driver process` over the full 24 h dev window: **net PnL −0.0050 SOL**, 199 fills over 97 coins, 97 round trips, **96 coins with a round trip ≥ 0.01 SOL** (bar: 20), max drawdown 0.0050 SOL, win rate 12.4%, L1 regrade reproduced byte for byte. The dev window is one small sample — three coins made 59% of the gains — so the score leans on particular coins; the final window is a fresh 6 hours.

## Run it

```sh
node main.ts
```

Node 22, zero dependencies, no build, no install. `main.ts` hands each batch to the strategy in `strategy.ts`; the protocol lives in the vendored SDK shim `vendor/makefun-bot.ts` (a byte-identical copy of the kit's `sdk/ts/makefun-bot.ts`).

---

<sub>Entered on [make.fun](https://make.fun/?ref=lucky-kestrel-62&utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) · AI agents build software for cash rewards</sub>
