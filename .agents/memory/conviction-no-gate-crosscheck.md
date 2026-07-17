---
name: Conviction zone enforcement — fail-closed gate + post-fill emergency close
description: How conviction fills are guaranteed to land in zone. Fail-closed fresh orderbook is layer 0; NO cross-check applies to FOK only (not GTC).
---

## Zone definition (current)
`lockPrice=0.91`, `lockPriceCap=0.96`
- YES zone: YES price in [91¢, 96¢]
- NO zone: YES price in [4¢, 9¢] (equivalently NO price in [91¢, 96¢])

## Root causes of historic out-of-zone fills
1. **Kalshi silently changed the authenticated orderbook API**: `orderbook` (integer cents)
   → `orderbook_fp` (string-dollar arrays, ascending; best bid = LAST element). Old parser
   returned null 100% → tick fell back to stale public prices (showed 0.908 while real ask
   was 0.79) → FOK limit 0.93 filled at 0.79.
2. Emergency close then deleted the window lock → re-buy loop up to 4x/window, bleeding
   spread each cycle (XRP 79-84¢ fills).
3. Kalshi FOK BUY fills at any ask ≤ limit (no floor); pre-order checks only shrink the
   race window, never eliminate it.

## Current layered design (kalshi-bot-tick.ts conviction block)
- **Layer 0 — fail closed**: freshYesAsk/freshYesBid come ONLY from the authenticated
  orderbook (`orderbook_fp` parser in crypto-kalshi.ts, legacy fallback + warn). If the
  orderbook fetch fails → ABORT the order, release the window lock, retry next 1s tick.
  Never fall back to public/cached prices for order placement.
- **Main zone gate**: fresh ref price must be in [lockPrice, lockPriceCap], GATE_BUFFER=0.
  - YES: freshYesAsk in zone
  - NO: (1 - freshYesBid) in zone
- **Cross-checks — FOK taker orders only** (`!usedPollerFallback`):
  - NO side: `freshYesAsk > (1−lockPrice)+0.01` → abort (prevents stale YES bid giving
    false in-zone signal while real YES ask is out of zone). Threshold = 10¢ for lockPrice=0.91.
  - YES side: `freshYesBid < lockPrice` → abort (hard floor: bid must be in zone).
  - **IMPORTANT**: These checks are SKIPPED for GTC maker orders (`usedPollerFallback=true`).
    For GTC, the limit price is set to exactly the YES bid (e.g. 8¢ YES = 92¢ NO).
    A GTC sell-YES at 8¢ can ONLY fill at ≥8¢ — the YES ask is irrelevant. Applying
    the cross-check to GTC incorrectly blocks all NO bets in wide-spread empty-book markets.
- **Order limit = exact verified bid/ask**, clamped inside the zone.
- **Layer 3 — post-fill emergency close (RE-ENABLED)**: after fill, `convFillPrice = avgPrice`
  (YES) or `1 − avgPrice` (NO); outside [lockPrice, lockPriceCap] → immediate sell, position
  never recorded. **Strike counter**: `convictionEmergencyCloses` Map (state.ts) caps
  emergency closes at 2 per coin/window; after 2 strikes the coin is locked out for the
  window. Cleared on window transition in loop.ts.

**Why the cross-check bypass for GTC matters:**
- Wide-spread markets (e.g. YES bid=7.9¢, YES ask=12¢, spread=5.1¢) are common in
  low-liquidity coins.
- pollerRefPrice = 1 - YES bid = 92.1¢ → correctly in zone for NO
- YES ask = 12¢ → exceeds the 10¢ threshold → cross-check incorrectly aborts GTC
- With GTC, orderLimitPrice = ceil(YES bid × 100)/100 = 8¢ → NO fill = 92¢ (in zone)
- The YES ask at 12¢ literally cannot affect a sell order at 8¢
