---
name: Conviction zone enforcement — fail-closed gate + cross-check bugs fixed
description: Three cross-check bugs blocked valid YES/NO conviction bets; architecture of the live-price gate and cross-checks.
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

### Bug 2 — YES cross-check too strict when `usedPollerFallback=true`
Cross-check aborts when `freshYesBid < lockPrice`. When the book is empty and we use the
poller-fallback path, the FOK order is placed at exactly `freshYesAsk` — the fill is
guaranteed to be `freshYesAsk` or no fill. The bid position is irrelevant; only the ask
matters. The bid check was blocking SOL/ZEC with ask=0.921 (in zone) and bid=0.90 (1¢ below
floor due to normal spread straddling the zone boundary).

**Fix**: guard with `&& !usedPollerFallback`. When book has resting orders the bid check
still applies (a low bid means sub-zone asks could exist and fill the FOK at below-zone prices).

### Bug 3 — NO cross-check float bug: threshold computed as 0.09999... instead of 0.10
`(1 - 0.91) + 0.01` evaluates to `0.09999...` in IEEE 754 double precision (because
`1 - 0.91 = 0.08999...`). The constant `0.10` in double is `0.10000...0555`, which is
greater than `0.09999...`, so BNB with `freshYesAsk=0.10` was falsely aborted.

**Fix**: `Math.round(((1 - lockPrice) + 0.01) * 100) / 100` — rounds to 2 decimal places.

## Current layered design (kalshi-bot-tick.ts conviction block)
- **Layer 0 — fail closed**: freshYesAsk/freshYesBid come ONLY from authenticated orderbook
  (`orderbook_fp` parser) or poller fallback (empty book only). Fetch failure → ABORT.
- **Main zone gate**: fresh ref price must be in [lockPrice, lockPriceCap].
  - YES: freshYesAsk in zone
  - NO: (1 - freshYesBid) in zone  (the poller zone check at this point uses noAsk directly)
- **Cross-checks**:
  - NO side: `freshYesAsk > round((1−lockPrice)+0.01)` → abort. Threshold = 10¢ for 0.91.
  - YES side: `freshYesBid < lockPrice && !usedPollerFallback` → abort.
- **Order limit = exact verified ask/bid**, clamped inside the zone. No crossing buffer.
- **Layer 3 — post-fill emergency close**: `convFillPrice` outside [lockPrice, lockPriceCap]
  → immediate sell. `convictionStopLossFloor=0.75` keeps fills [75¢,91¢) as stop-loss.
  `convictionEmergencyCloses` Map caps closes at 2/coin/window. `windowFailedFills` Set
  prevents rebuy bleed after FOK exhaustion.
