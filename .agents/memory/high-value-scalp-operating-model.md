---
name: High-value scalp operating model
description: Price-led late-window execution is intentionally independent of ordinary bot gates.
---

High-value scalping is a separate, opt-in, price-led execution path. It checks every configured market on the normal one-second bot cadence during its configured final-window range and does not use ordinary model signals, quiet hours, market filters, pauses, or conviction gates to decide whether to enter.

**Why:** The user explicitly wants risk primarily constrained by the late timing and the high-confidence market-price band, rather than by the ordinary bot’s more restrictive signal stack.

**How to apply:** Keep fresh two-sided pricing, final pre-submit validation, confirmed-fill persistence, paper/live isolation, opposite-position protection, and independent exposure/daily-spend caps. Do not introduce normal-entry gates or a slower scanner cadence into this path without explicit user direction.