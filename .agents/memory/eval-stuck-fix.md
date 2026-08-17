---
name: Eval stuck-forever fix
description: How evalClosedBets handles rows that have no price data and no stored P&L past the 90-s defer window
---

## The rule
When `closePrice === null` AND `pastDeferWindow === true` AND `fallbackPnl === null` (no stored P&L at all), the OLD code did `continue` — permanently stuck.

**Fix (kalshi-bot-eval.ts):**
1. Attempt one final `fetchKalshiResultWithRetry(row.ticker, 1)`.
2. If settled → commit proper P&L from Kalshi result + increment `evaluated`.
3. If still not settled → commit `outcome: 'loss'` with conservative P&L (`-ep*n` for YES, `-(1-ep)*n` for NO). Row is NEVER permanently stuck after this.

`reEvaluateSettledBets` auto-corrects conservative losses once Kalshi publishes final settlement. It runs automatically every 30 min (scheduled in `runBotLoopTick` via `_lastReEvalAt` pattern, same as `_lastShadowEvalAt`).

**Why:** The Kalshi settlement API can be slow (10-30s after window close). A row with no price data and no stored P&L is exactly the case where the conservative-loss + auto-correct pattern applies.

## `fetchKalshiResultWithRetry`
Added as a module-private helper in eval.ts before `evalClosedBets`. 3 attempts, 1.5s between. Returns the last result on exhaustion (never throws). Also replaces the existing single `fetchKalshiMarketResult` call in the main evaluation path.

## import safety
`recomputeSymbolQuietHours` imported from `./kalshi-bot-db` in eval.ts. No circular dep: db.ts does NOT import from eval.ts (confirmed by inspection). The barrel `kalshi-bot-engine` does not re-export from eval.ts.
