---
name: Contrarian durable ownership
description: Cross-worker ownership and reconciliation invariants between the normal Scalper and the Contrarian Spike experiment.
---

Normal Scalper and Live Contrarian claims must serialize on one database advisory lock. Their mutual-exclusion key is source mode + symbol + window; ticker identity is audit evidence, not part of ownership.

**Why:** Different workers can temporarily resolve different tickers for the same market window. Including ticker in the conflict key permits both execution lanes to claim exposure despite referring to the same economic window.

**How to apply:** Count an active claimed reservation as ownership before an order intent exists. Query the other lane while holding the shared transaction lock. Keep Paper experiment ownership isolated from Live normal execution.

Order reconciliation may transition only unresolved states. A stale worker must never overwrite a decisive zero-fill, fill, or settlement, and exposure may be released only by the worker that wins the conditional transition.