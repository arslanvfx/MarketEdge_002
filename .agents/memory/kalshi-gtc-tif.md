---
name: Kalshi GTC time_in_force
description: Kalshi API has oscillated between "gtc" and "good_till_cancelled"; mapping in trader.ts handles the conversion — update here when it drifts again
---

**Rule:** The Kalshi API has changed the accepted `time_in_force` value multiple times. Always route GTC orders through the mapping in `kalshi-trader.ts` `placeOrder()` — never hardcode the wire value elsewhere.

**Current state (as of 2026-07-17):** `"good_till_cancelled"` is the accepted wire value. `"gtc"` is rejected with 400 `invalid_parameters` / "TimeInForce failed on the 'oneof' tag".

**History of drift:**
1. Originally accepted: `"good_till_cancelled"`
2. Briefly required: `"gtc"` (caused us to add a map of `"good_till_cancelled"` → `"gtc"`)
3. Reverted again: `"gtc"` rejected, `"good_till_cancelled"` accepted — map is now `"gtc"` → `"good_till_cancelled"`

**How to apply:**
- `kalshi-trader.ts` `placeOrder()` body maps `params.timeInForce === "gtc"` → `"good_till_cancelled"` on the wire
- Internal code (kalshi-bot-tick.ts etc.) should continue sending `timeInForce: "gtc"` — the mapping handles the translation
- `"fill_or_kill"` and `"immediate_or_cancel"` pass through unchanged — do not change those
- If the API rejects again with the same 400 oneof tag error, the mapping in `kalshi-trader.ts` is the only place to change

**Why:** Kalshi v2 API validates `TimeInForce` against a strict oneof enum that changes without notice. Centralizing the mapping in one place (trader.ts) means future drift only requires a one-line fix.
