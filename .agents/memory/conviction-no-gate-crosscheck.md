---
name: Conviction zone enforcement — fail-closed gate + post-fill emergency close
description: How conviction fills are guaranteed to land in [lockPrice−2¢, lockPrice+2¢] (target 0.90 → [0.88, 0.92]). Fail-closed fresh orderbook is layer 0; post-fill emergency close (max 2 strikes) is the hard guarantee.
---

## Zone definition (current)
Target `kalshiLockPrice = 0.90`, zone symmetric ±2¢ → **[0.88, 0.92]** YES / [0.08, 0.12] NO cost.
One-time flag-gated migration (`lockPrice090Migrated`) moved stored 0.91 → 0.90 via pure
helper `applyLockPrice090Migration` in engine-core (unit-tested). The flag is set on EVERY
evaluated config — even ones already at 0.90 — so a user who later deliberately sets 0.91
is never auto-reverted on restart.

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
- **Cross-checks**: NO side `freshYesAsk > (1−lockPrice)+0.01` → abort; YES side
  `freshYesBid < lockPrice` → abort (hard floor: bid must be in zone).
- **Order limit = exact verified ask**, clamped inside the zone.
- **Layer 3 — post-fill emergency close (RE-ENABLED)**: after fill, `convFillPrice = avgPrice`
  (YES) or `1 − avgPrice` (NO); outside [lockPrice, lockPriceCap] → immediate sell, position
  never recorded. **Strike counter**: `convictionEmergencyCloses` Map (state.ts) caps
  emergency closes at 2 per coin/window; after 2 strikes the coin is locked out for the
  window (prevents re-buy loop). Cleared on window transition in loop.ts.

**Why the emergency close was previously disabled and re-enabled:**
- Was disabled because the old XRP bleed loop (4× close/re-buy in one window). The loop
  was caused by the emergency close releasing `convictionFiredThisWindow` unconditionally.
- Current code already fixed the loop: `MAX_EMERGENCY_CLOSES_PER_WINDOW = 2` limits closes,
  and after 2 the window lock stays set. Re-enabling the check is now safe.
- Root cause of the out-of-zone fills: Kalshi FOK BUY fills at any ask ≤ limit (no price
  floor). Pre-order gates narrow the race window but cannot eliminate it. Post-fill check
  is the only layer that acts on the ACTUAL exchange fill price.

**Why:** only the post-fill check acts on the ACTUAL exchange price; everything earlier
just narrows the race window. Fail-closed layer 0 removes the stale-price class entirely.
