---
name: Conviction gate cross-checks + post-fill emergency close
description: Three-layer system to guarantee conviction fills land in [lockPrice, lockPriceCap]. Pre-order cross-checks (layers 1+2) tightened to 3¢. Layer 3 (post-fill emergency close) is the true hard guarantee.
---

## Root causes of out-of-zone fills

### NO direction — stale yesBid + wide cross-check tolerance
Gate checks `1 − freshYesBid ∈ [lockPrice, lockPriceCap]`.
If `freshYesBid` is stale, gate passes while market has bounced.
Original NO cross-check tolerance was **10¢** — allowed YES ask at 14¢ through when
target was 12¢; exchange then filled at YES bid 17¢ = NO 83¢.
**Observed:** NEAR NO 83¢ fill (YES ask was ~14¢ at gate, bid rose to 17¢ before fill).

### YES direction — stale orderbook OR race condition
Gate checks `freshYesAsk ∈ [lockPrice, lockPriceCap]`.
**Observed:** DOGE YES 78¢ (9¢ race), SOL YES 61¢ (25¢ stale fallback).

## The three-layer fix (as implemented)

### Layer 1 — NO cross-check, tolerance 10¢ → 3¢
```typescript
const yesAskBounceThreshold = (1 - lockPrice) + 0.03; // was + 0.10
if (freshYesAsk > yesAskBounceThreshold) { /* abort */ }
```
lockPrice=0.88: threshold=0.15. freshYesAsk=0.16 > 0.15 → abort ✓
Catches: YES ask at 16¢+ when target is 12¢.

### Layer 2 — YES cross-check, tolerance 5¢ → 3¢
```typescript
const yesBidDropThreshold = lockPrice - 0.03; // was - 0.05
if (freshYesBid < yesBidDropThreshold) { /* abort */ }
```
lockPrice=0.88: threshold=0.85. freshYesBid=0.84 → abort ✓

### Layer 3 — Post-fill emergency close (TRUE hard guarantee)
After `placeOrderWithRetry` returns, check the actual Kalshi fill price.
`result.avgPrice` is always YES-side. Convert for NO: `convFillPrice = 1 - result.avgPrice`.
```typescript
if (S.config.decisionMode === "conviction" && result.avgPrice != null) {
  const _gt    = S.config.kalshiLockPrice ?? 0.90;
  const _lp    = +(_gt - 0.02).toFixed(4);
  const _lpCap = +(_gt + 0.03).toFixed(4);
  const convFillPrice = direction === "yes" ? result.avgPrice : 1 - result.avgPrice;
  if (convFillPrice < _lp || convFillPrice > _lpCap) {
    // sellYes(ticker, count) or sellNo(ticker, count) — immediately
    convictionFiredThisWindow.delete(`${sym}:${windowKey}`);
    return; // do NOT record as open position
  }
}
```
This runs after the exchange fill, so it acts on the real price regardless of any
pre-order race condition. Position is closed before it enters our records.

**Why re-derive lockPrice at fill time:** `lockPrice`/`lockPriceCap` are scoped inside
the conviction `if` block (line ~1512) which closes before `placeOrderWithRetry` (line ~1771).

**Why:** Kalshi limit orders fill at exchange price — BUY YES at ask ≤ limit (no floor),
SELL YES (= BUY NO) at bid ≥ limit (no ceiling). Pre-order checks only reduce the race
window; they cannot eliminate it. Layer 3 is the only mechanism that acts on the ACTUAL fill.

**How to apply:** All layers in `kalshi-bot-tick.ts` conviction block. Order:
orderbook null warn → main zone gate → NO cross-check (L1) → YES cross-check (L2) →
recompute sizing → placeOrderWithRetry → post-fill zone check (L3).
