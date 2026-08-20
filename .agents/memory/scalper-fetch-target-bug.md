---
name: Scalper price source and window timing
description: How the high-value scalper gets prices and how the scan window is calibrated; includes all bugs fixed that caused zero bets after initial launch.
---

## Rule
The high-value scalper MUST use `getConvictionLivePrice(sym)` (the conviction poller cache) as the **exclusive** price source for both the initial scan phase and the final pre-submit price check. It must NEVER call `fetchOrderbookPrices` during the scan or final check.

## Why
Three bugs caused zero bets after initial launch:

1. **`fetchKalshiTarget(sym, targetTime)` bypass** — passing `targetTime` skips the shared cache and makes a live API call per tick. During busy end-of-window periods, 429s cause the normal bot loop's handler to write `{ value: null }` into `kalshiTargetCache`. The scalper then reads back `value=null` → silent exit. Fix: read `kalshiTargetCache.get(sym)` directly (no `fetchKalshiTarget` call at all from the scalper).

2. **Orderbook returns different prices than poller** — `fetchOrderbookPrices` consistently returns crossed quotes, 429 errors, or prices that diverge from what the conviction poller (and MarketEdge UI) shows. Using it as primary source in the scan caused coins the user could SEE at 90-95% to be rejected as "outside band" or "crossed quote".

3. **Final pre-submit check also used orderbook** — even after the scan correctly identified a coin as eligible (via poller), the final check called `fetchOrderbookPrices` again and overrode the poller with wrong prices, rejecting valid bets at the last step.

## How to Apply
- `scanSymbol` scan phase: `const pollerPrice = getConvictionLivePrice(sym)` only. No `fetchOrderbookPrices`.
- `scanSymbol` final pre-submit check: same — poller only. No `fetchOrderbookPrices`.
- `fetchOrderbookPrices` is NOT imported in `kalshi-high-value-scalper.ts`.
- `fetchKalshiTarget` is NOT called from the scalper.

## Window timing
The scalp band is 90-95% YES/NO. Empirically, coins transit this band at ~9 minutes into a 15-minute window (secondsRemaining ≈ 360). By 2 minutes remaining (secondsRemaining=120), coins are at 98-99%. Therefore:
- `highValueScalpMaxSecondsRemaining` must be **360** (not 120).
- DB default row (`id='default'`) must have this value.
- Code default in `kalshi-bot-engine-core.ts` must also be 360.

## Daily cap
- `highValueScalpMaxDailySpend` default raised to **$2000** (DB + code). The original $1000 was consumed by the initial working window (8-10 bets × ~$100).
- `highValueScalpMaxOpenExposure` default raised to **$800** (was $100).
- Daily spend is tracked in-memory only (`paperHighValueScalpDailySpend` / `liveHighValueScalpDailySpend`) and resets on server restart.
