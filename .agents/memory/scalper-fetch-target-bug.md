---
name: High-value scalper fetchKalshiTarget bypass bug
description: The scalper's call to fetchKalshiTarget(sym, targetTime) bypasses the cache and causes 429-induced cache poisoning that silently kills every scan.
---

# Root cause

`scanSymbol` was calling `fetchKalshiTarget(sym, new Date(timing.closeAt))` with `targetTime` set.

`fetchKalshiTarget` has two code paths:
- `!targetTime` → uses TTL cache, only fetches if stale
- `targetTime` → **bypasses cache entirely**, always makes a live API call

During the busy end-of-window period, the normal bot loop is already hammering the Kalshi API every tick for all 12 coins. These calls return 429 frequently. The normal bot loop's own 429 handler (line 285 in crypto-kalshi.ts) writes `{ value: null, at: Date.now() }` into the cache (NO ticker, NULL value). Then the scalper's `fetchKalshiTarget(sym, targetTime)` ALSO hits 429 but since `targetTime` is set, it does NOT update the cache. The scalper then reads `kalshiTargetCache.get(sym)` and sees `{ value: null }` from the normal loop's 429 handler → `market.value == null` → silent return. Every coin. Every tick. Every window.

# Fix

Removed the `fetchKalshiTarget(sym, new Date(timing.closeAt))` call entirely from `scanSymbol`. The scalper now reads `kalshiTargetCache` directly — the same shared cache the conviction poller and normal bot loop keep fresh every 1-5 seconds. Added a `closeTime` window-validation check to reject pre-published next-window markets (Kalshi pre-publishes ~10 min early).

**Why:** The scalper should be a READER of the shared cache, not a writer. It runs in the last 2 minutes when the API is under the most load. Making extra uncached API calls during that period is the worst time to do it.

# Three compounding bugs (all now fixed)

1. Empty authenticated orderbook → null prices → fell back to nothing (fixed: conviction poller fallback)
2. `yesBid` missing when `no_ask_dollars` absent → policy null-check rejects (fixed: synthesize from `noAsk`)  
3. `fetchKalshiTarget(targetTime)` → bypasses cache → 429 → normal loop's 429 poisons cache to null value → silent exit before eligibility (fixed: remove the call, read cache directly)
4. All skip logs were DEBUG-level → invisible (fixed: INFO with priceSource field)

# Cache window validation

After removing the targetTime call, added a closeTime guard to prevent using a pre-published next-window market:
- `Math.abs(market.closeTime - timing.closeAt) > 8*60*1000` → skip with log
- If `market.closeTime` absent → skip validation (429-set entries have no closeTime but also no ticker/value → caught by existing null check)
