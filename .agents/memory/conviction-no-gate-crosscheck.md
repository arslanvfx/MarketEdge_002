---
name: Conviction gate cross-checks — YES ask (NO) and YES bid (YES)
description: Stale orderbook data or race conditions let bounced/crashed markets pass the conviction gate and fill at wrong prices. Two cross-checks (one per direction) prevent this.
---

## Root causes

### NO direction — stale yesBid
Gate checks `1 − freshYesBid ∈ [lockPrice, lockPriceCap]`.
If `freshYesBid` is stale (orderbook refresh failed), gate passes while market has bounced.
The FOK `orderLimitPrice = 0.06` fills at ANY YES bid ≥ 6¢ → 76¢ NO fill.
**Observed:** NEAR NO [89–94%], trigger at YES=7¢, fill at NO=76¢ (YES bounced to 24¢).

### YES direction — stale/slow orderbook OR race condition
Gate checks `freshYesAsk ∈ [lockPrice, lockPriceCap]`.
Two failure modes:
1. **Orderbook fetch failed** → falls back to public market list `freshData.yesAsk`, which can lag 30–60s → gate sees 87¢, exchange already at 61¢ → FOK fills at 61¢.
2. **Race condition** → orderbook was fresh at 87¢ but price crashed 9¢ between gate check and FOK execution → FOK BUY YES fills at current ask (no minimum floor on buy limits).
**Observed:** DOGE YES 87¢ lock, fill at 78¢ (9¢ race). SOL YES 86¢ lock, fill at 61¢ (25¢ stale fallback).

## The fixes

### Fix 1 — Require authenticated orderbook (both directions)
Before the gate check, abort if `obPrices == null`. Do NOT fall back to the public
market list for conviction orders. Stale mid-prices are unacceptable.

```typescript
if (obPrices == null) {
  convictionFiredThisWindow.delete(`${sym}:${windowKey}`);
  // restore boostBetSize token if held
  logger.warn(..., "authenticated orderbook unavailable — aborting");
  return;
}
```

### Fix 2 — NO cross-check (stale-bid guard)
After main gate passes, use `freshYesAsk` (independent from `yesBid`) to detect bounce:

```typescript
if (direction === "no" && freshYesAsk != null) {
  const yesAskBounceThreshold = (1 - lockPrice) + 0.10; // target + 10¢
  if (freshYesAsk > yesAskBounceThreshold) { /* abort */ }
}
```
lockPrice=0.89: threshold=0.21. freshYesAsk=0.24 > 0.21 → abort ✓

### Fix 3 — YES cross-check (stale-ask / race-condition guard)
After main gate passes, use `freshYesBid` (tracks ask within 1–3¢) to detect crash:

```typescript
if (direction === "yes" && freshYesBid != null) {
  const yesBidDropThreshold = lockPrice - 0.05; // 5¢ below floor
  if (freshYesBid < yesBidDropThreshold) { /* abort */ }
}
```
lockPrice=0.85 (gateTarget=0.87): threshold=0.80. freshYesBid=0.76 < 0.80 → abort ✓

**Why 5¢ for YES vs 10¢ for NO:** YES bid/ask spreads are narrower in conviction territory (87–93¢). 5¢ catches crashes without false positives.

**Why:** Kalshi BUY limit orders fill at best available ask ≤ limit — there is no minimum fill price. The gate is the only protection. Both cross-checks use the opposite side of the book to catch what the main gate cannot detect via its primary data source.

**How to apply:** All three checks live in `kalshi-bot-tick.ts` inside the `if (S.config.decisionMode === "conviction")` block, in order: orderbook null check → main zone gate → NO cross-check → YES cross-check → recompute sizing.
