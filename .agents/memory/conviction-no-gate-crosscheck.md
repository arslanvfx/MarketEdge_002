---
name: Conviction zone enforcement and price-improved fills
description: Authenticated-book authorization and the hold-not-sell policy for exchange price improvements.
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

## Three cross-check bugs fixed (July 2026)

### Bug 1 — NO zone miss: `noAsk` computed as `1-yesBid` (stale)
The Kalshi API updates `no_ask_dollars` and `yes_bid_dollars` independently. During rapid
moves (e.g. ETH NO jumping from 71¢→92¢), `no_ask_dollars` updates first while
`yes_bid_dollars` stays at the old value. Computing `noTrigger = 1 - yesBid` misses zone
entry even when `no_ask_dollars` is clearly in zone.

**Fix**: store `noAsk` directly from `no_ask_dollars` in both `kalshiTargetCache` and
`convictionPriceMap`. `ConvictionInputs` gains a `noAsk` field; `computeConvictionDecision`
prefers `noAsk` over `1 - yesBid` as the primary NO trigger.

### Poller fallback is not authorization
Public/poller prices can help detect candidates, but they cannot authorize a conviction
submission. A timed-out, empty, incomplete, stale, or insufficient-depth authenticated book
must fail closed and wait for a later tick.

### Bug 3 — NO cross-check float bug: threshold computed as 0.09999... instead of 0.10
`(1 - 0.91) + 0.01` evaluates to `0.09999...` in IEEE 754 double precision (because
`1 - 0.91 = 0.08999...`). The constant `0.10` in double is `0.10000...0555`, which is
greater than `0.09999...`, so BNB with `freshYesAsk=0.10` was falsely aborted.

**Fix**: `Math.round(((1 - lockPrice) + 0.01) * 100) / 100` — rounds to 2 decimal places.

## Current layered design
- **Layer 0 — fail closed**: live entry evidence comes only from authenticated order books.
  Public/poller fallback may not authorize an order.
- **Main zone gate**: fresh ref price must be in [lockPrice, lockPriceCap].
  - YES: freshYesAsk in zone
  - NO: (1 - freshYesBid) in zone
- **Cross-checks**:
  - NO side: `freshYesAsk > round((1−lockPrice)+0.01)` → abort. Threshold = 10¢ for 0.91.
  - YES side: `freshYesBid < lockPrice` → abort.
- **Order limit = exact verified ask/bid**, clamped inside the zone. No crossing buffer.
- **Final authenticated gateway**: the exact ticker must expose fresh full requested depth
  inside the band, and the same immutable book version must still be current at the broker
  boundary.
- **Authoritative fill audit**: every positive conviction fill is checked
  against the immutable, canonical per-symbol band captured before the live intent claim.
  This must never use mutable post-await config or the stale decision quote.
- An out-of-band exchange price improvement is persisted at the actual price and tagged for
  audit, but held through normal position settlement. Never submit an automatic opposite-side
  order solely because a BUY filled more cheaply than the authorization floor.
- Durable intents store the authorization mode/floor/cap. Restart reconciliation tags an
  out-of-band recovered fill before hydration; that tag is audit-only and must not trigger
  an automatic unwind.
- `windowFailedFills` Set still prevents rebuy bleed after FOK exhaustion.

**Why:** A BUY limit is only a maximum price, never a minimum. During a slow exchange request,
Kalshi can legally match a newly cheaper offer after final validation. Selling immediately
cannot undo the entry and can turn a position that later wins into a guaranteed spread loss.
The immediate-unwind regression was introduced after the previously working hold behavior.

**How to apply:** Require authenticated full-depth evidence at every submission boundary.
Audit actual fills against the authorization snapshot, retain ownership after every positive
or ambiguous result, and let normal risk/settlement policy manage a price-improved position.
