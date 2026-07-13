---
name: Conviction NO gate — YES ask cross-check
description: Stale yesBid in the live-price gate lets a bounced market pass and fills NO at the wrong price via an uncapped FOK limit-sell.
---

## The bug

For NO conviction bets the gate checks `1 − freshYesBid ∈ [lockPrice, lockPriceCap]`.
If `freshYesBid` is stale (orderbook refresh failed, cached value still shows the
trigger-time bid), the gate passes even though the real market has bounced.

The recompute then sets `orderLimitPrice = 1 − lockPriceCap` (e.g., 0.06).
In Kalshi v2, buying NO = ask-side (sell-YES) FOK: "fill if YES bid ≥ 0.06".
A 24¢ YES bid satisfies this immediately → 76¢ NO fill, far outside the conviction zone.

**Observed case:** NEAR NO conviction zone [89–94%] (lockPrice=0.89).
Trigger at YES=7¢ (NO=93¢). By fill time YES bounced to 24¢ (NO=76¢).
Gate passed because freshYesBid was stale at 7¢.

## The fix

After the main gate passes, a secondary cross-check uses `freshYesAsk`
(a different data path than yesBid, comes from the authenticated orderbook):

```typescript
if (direction === "no" && freshYesAsk != null) {
  const yesAskBounceThreshold = (1 - lockPrice) + 0.10; // target + 10¢ spread allowance
  if (freshYesAsk > yesAskBounceThreshold) { /* abort */ }
}
```

For lockPrice=0.89: threshold = 0.11 + 0.10 = 0.21 (21¢).
freshYesAsk=0.24 > 0.21 → abort ✓
freshYesAsk=0.14 → passes ✓ (normal conviction-time spread)

**Why:** Kalshi limit-sell orders (NO buys) fill at *any* YES bid ≥ limit.
There is no way to cap the fill price via the order itself — the gate is
the only protection. The cross-check uses the ask side (independent of bid)
to catch market bounces that stale bid data cannot detect.

**How to apply:** The cross-check lives in `kalshi-bot-tick.ts`, immediately
after the `if (!inWindow) { return; }` block, before the recompute section.
The 10¢ allowance covers normal bid-ask spreads in thin markets. Do NOT
increase it beyond 12¢ or it will miss realistic bounce scenarios.
