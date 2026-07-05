---
name: Live-ask fill price
description: Bot now places Kalshi orders at the live yes_ask/yes_bid rather than the cached midpoint + buffer, bypassing the return-multiple cap that blocked fills.
---

## Rule
Store `yesAsk` and `yesBid` in `kalshiTargetCache` (from the existing Kalshi markets API response). At fill time in `_runBotTick`, read them via `getKalshiCachedData(sym)` and pass `limitPrice = yesAsk` (YES) or `limitPrice = yesBid` (NO) to `placeOrderWithRetry`. The `PlaceOrderParams.limitPrice` field bypasses `computeMarketableLimitPrice` entirely.

**Why:** The old path computed `min(midpoint + 0.15, 1/minReturnMultiple)`. With `minReturnMultiple=1.4` the cap is 0.714, so a YES ask of 0.72+ could never fill — even with Phase 2 price escalation walking from 0.71. The return-multiple was already enforced as a Phase 3 decision gate; the fill-time cap was redundant and actively blocked legitimate fills.

**How to apply:**
- `kalshi-trader.ts` `PlaceOrderParams` has `limitPrice?: number`. When set, `placeOrder()` uses it directly (+ priceImprovementCents walks from this base). `minReturnMultiple` is ignored.
- `kalshi-bot.ts` `_runBotTick()` uses `getKalshiCachedData(sym)` (NOT the `yesPrice` function parameter) to read `yesAsk`/`yesBid`. Falls back to old midpoint+buffer when bid/ask absent.
- Contract count = `floor(betSize / yesAsk)` for YES; `floor(betSize / (1 - yesBid))` for NO.
- `minReturnMultiple` stays as a decision gate in Phase 3 only — never use it as a fill-time price cap.
