---
name: Kalshi GTC time_in_force
description: Kalshi v2 API rejects "good_till_cancelled" as a time_in_force value; must use "gtc"
---

**Rule:** Never send `time_in_force: "good_till_cancelled"` to the Kalshi API. Use `"gtc"` instead.

**Why:** Kalshi v2 API validates `TimeInForce` against a strict oneof enum. The long-form `"good_till_cancelled"` is rejected with a 400 `invalid_parameters` error. `"fill_or_kill"` and `"immediate_or_cancel"` remain valid as-is. This caused the GTC stop-loss fallback in `kalshi-bot-close.ts` to fail on every retry, leaving positions stuck open indefinitely.

**How to apply:**
- In `kalshi-trader.ts` `placeOrder()` body construction: a defensive map translates `"good_till_cancelled"` → `"gtc"` before the fetch
- The `timeInForce` type union now includes `"gtc"` as an explicit option
- Any future GTC order must pass `timeInForce: "gtc"` (not the long form)
- `"fill_or_kill"` and `"immediate_or_cancel"` still work — do not change those
