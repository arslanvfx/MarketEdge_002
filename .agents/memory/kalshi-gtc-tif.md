---
name: Kalshi GTC time_in_force
description: Kalshi does not support any GTC/resting order type. Only "fill_or_kill" and "immediate_or_cancel" are valid. GTC was removed from conviction bot.
---

**Rule:** Kalshi only accepts `"fill_or_kill"` and `"immediate_or_cancel"` for `time_in_force`. GTC is not supported.

**Current state (as of 2026-07-17):** Both `"gtc"` AND `"good_till_cancelled"` return 400 `invalid_parameters` / "TimeInForce failed on the 'oneof' tag". GTC does not exist in Kalshi's accepted enum.

**History of drift:**
1. Originally accepted: `"good_till_cancelled"`
2. Briefly required: `"gtc"` (caused us to add a map of `"good_till_cancelled"` → `"gtc"`)
3. `"gtc"` rejected, `"good_till_cancelled"` re-accepted → map updated
4. Both rejected entirely → **GTC approach abandoned** (2026-07-17)

**Resolution:** The conviction bot's empty-book path was rewritten to use FOK orders instead of GTC. Market makers on Kalshi fill FOK orders reactively (they don't post resting orders in the authenticated book). The poller spread gate (≤4¢ YES / ≤6¢ NO) confirms in-zone liquidity before placing the FOK.

**How to apply:**
- `kalshi-trader.ts` `placeOrder()` passes `timeInForce` through unchanged (no mapping needed).
- `kalshi-bot-tick.ts` uses `placeOrderWithRetry` for all conviction entries (both poller-fallback and real-book paths).
- Do NOT attempt GTC/resting orders on Kalshi — they will always 400.

**Why:** Kalshi market makers quote prices via the public feed but fill FOK orders on demand. The authenticated orderbook is consistently empty because market makers operate reactively, not with posted resting orders.
