---
name: FOK 409 throw/swallow split (entry vs exit)
description: Why placeOrder must re-throw fill_or_kill_insufficient_resting_volume and only the entry retry helper may swallow it
---

# fill_or_kill 409 throw/swallow split

Kalshi orders use `time_in_force: fill_or_kill`. On a thin book a FOK order is
"killed" and surfaces as a THROWN 409 (`fill_or_kill_insufficient_resting_volume`)
from `kalshiFetch` → `placeOrder`.

**Rule:** `placeOrder` MUST re-throw that 409. Do NOT swallow it inside `placeOrder`.
Only the ENTRY retry helper (`placeOrderWithRetry`) may catch it and treat it as a
soft unfilled result to retry. Non-FOK errors always propagate everywhere.

**Why:** exits go `closePosition → sellYes/sellNo → placeOrder` DIRECTLY (not through
the retry helper) and detect failure ONLY via a thrown error — the throw is what keeps
a live position OPEN and forces a retry next tick. If `placeOrder` swallowed the FOK
and returned `filledCount:0`, `closePosition` would treat a killed real-money exit as
success and orphan the position on the exchange. This exact swallow-in-placeOrder was
caught in review as a critical regression.

**How to apply:** put any "soft failure → retry" translation in the retry wrapper, not
in the shared `placeOrder`. `placeOrderWithRetry` = Phase 1 immediate same-price
retries (default 4), then Phase 2 bounded +1c price escalation up to
`priceImprovementMaxCents` (wired to `config.maxSlippageCents`). It takes an injectable
`placeFn` for unit tests so retry/escalation is testable without network I/O.
