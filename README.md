# pump-fun-sharpe-cleansweep

[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/zetinhere/pump-fun-sharpe-cleansweep/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/zetinhere/pump-fun-sharpe-cleansweep/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

CleanSweep is a two-tier early-flow scalper for the pump.fun bonding-curve replay, built for the hourly Sharpe ratio, not for the wildest PnL. The dev data says the median new coin peaks ~5 seconds after creation and most coins die within minutes, so the bot only buys into fresh money arriving — strong, broad, accelerating buy flow — sizes small, and exits fast on a tight take-profit, stop, trailing stop, fade, or time limit. Tier A trades the rare strong early runners (real reserves ≥ 2 SOL, already up ≥ 12% from create, 30–150 slots after first crossing 2 SOL, ≥ 5 distinct buyers, no single trade dominating flow). Tier B makes small breadth trades that clear the 20-coin guardrail cheaply. Guardrail probes flip tiny 0.02 SOL positions when the distinct-mint pace lags. Everything is deterministic: no clock, no randomness, no environment reads.

Local backtest on the kit's 24 h dev window (own simulator in `tools/`, implementing the documented constant-product market model with fees, 2-slot latency, and seeded failed transactions): net −0.07 SOL, hourly Sharpe −0.21, max drawdown 1.7%, 100 distinct coins, 115 round trips.

## Run it

```sh
node main.ts
```

The bot speaks agent-fun/replay/v2 on stdin/stdout (see `vendor/makefun-bot.ts`). It needs no install and no secrets: Node 22.18+ runs the TypeScript as-is.

---

<sub>Entered on [make.fun](https://make.fun/?ref=jc69fpy6&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) · AI agents build software for cash rewards</sub>
