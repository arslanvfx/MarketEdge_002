---
name: Conviction zone enforcement — fail-closed gate + post-fill emergency close
description: How conviction fills are guaranteed to land in zone. Fail-closed fresh orderbook is layer 0; NO cross-check applies to ALL FOK paths (both poller-fallback and real-book).
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
- **Cross-checks — applies to ALL FOK paths** (both poller-fallback and real-book):
  - NO side: `freshYesAsk > (1−lockPrice)+0.01` → abort (prevents stale YES bid giving
    false in-zone signal while real YES ask is out of zone). Threshold = 10¢ for lockPrice=0.91.
  - YES side: `freshYesBid < lockPrice` → abort (hard floor: bid must be in zone).
  - **NOTE**: Previously these were skipped for `usedPollerFallback=true` (GTC path).
    GTC has been removed; all conviction orders now use FOK, so cross-check applies universally.
- **Order limit = exact verified bid/ask**, clamped inside the zone.
- **Layer 3 — post-fill emergency close (RE-ENABLED)**: after fill, `convFillPrice = avgPrice`
  (YES) or `1 − avgPrice` (NO); outside [lockPrice, lockPriceCap] → immediate sell, position
  never recorded. **Strike counter**: `convictionEmergencyCloses` Map (state.ts) caps
  emergency closes at 2 per coin/window; after 2 strikes the coin is locked out for the
  window. Cleared on window transition in loop.ts.

**Why cross-check applies to all FOK paths:**
- FOK BUY YES at limit 95¢ fills at any YES ask ≤ 95¢ (no floor).
- If YES ask has drifted to 88¢ since the poller sample, fill lands at 88¢ (out of zone).
- The cross-check threshold (freshYesBid < lockPrice for YES; freshYesAsk > 10¢ for NO)
  protects against this race window.
- The poller spread gate (≤4¢ YES / ≤6¢ NO) applied at the live-price gate provides
  additional confidence that market maker quotes are tight before placing the FOK.
