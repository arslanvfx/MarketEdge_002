---
name: Confirmed zero-fill retries
description: Conviction zero fills are terminal for the symbol/window; uncertain outcomes remain locked
---

## Rule
Conviction entries get one live IOC submission per symbol/window. An authoritative zero fill is terminal for that window and must remain blocked durably across process restarts. Timeouts, malformed responses, transport failures, partial fills, positive fills, reserved orders, and unresolved outcomes also remain locked.

**Why:** A one-second retry policy allowed a poller-qualified conviction signal to submit again after the executable book had materially changed, producing an out-of-band fill. Fast retries are unsafe for a price-band premise.

**How to apply:** Keep the durable intent reservation authoritative. Conviction-tagged zero-fill intents permanently block another claim for the same live symbol/window; bounded cooldown retries remain available only to non-conviction modes.
