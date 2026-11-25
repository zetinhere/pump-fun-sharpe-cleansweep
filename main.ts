// CleanSweep — pump.fun Sharpe Sprint entry.
// Wires the strategy in strategy.ts to the agent-fun/replay/v2 harness shim.
import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
