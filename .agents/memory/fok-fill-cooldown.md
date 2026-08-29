---
name: Confirmed zero-fill retries
description: Fast conviction retries are allowed only after an authoritative zero fill; every uncertain outcome remains locked
---

## Rule
Conviction entries may retry quickly after the exchange authoritatively confirms that zero contracts filled. Timeouts, malformed responses, transport failures, partial fills, positive fills, reserved orders, and unresolved outcomes must never use that fast path.

**Why:** A long cooldown caused a valid DOGE entry band to disappear after a confirmed failed purchase, but treating an uncertain response as failed could create duplicate real-money orders.

**How to apply:** Keep the durable intent reservation authoritative. A short timer may reopen eligibility only after the intent is durably terminal as zero-fill; all quote, ticker, window, ownership, funding, and safety checks must run again before retry.
