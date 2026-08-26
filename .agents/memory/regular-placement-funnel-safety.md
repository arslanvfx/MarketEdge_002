---
name: Regular placement funnel safety
description: Safety rules for comparing paper opportunities with live regular-order placement without affecting execution.
---

**Rule:** Compare live placements only with paper candidates that pass the same live eligibility predicates. Paper evaluation must remain advisory and read-only: never claim an intent or imply executable liquidity. Split internal processing time from exchange-response time.

**Why:** Synthetic paper fills do not prove live balance, exposure capacity, intent availability, or exchange liquidity. Comparing all paper fills to live fills overstates a submission problem and hides the actual rejection stage.

**How to apply:** Reuse the live slippage, spend, balance, exposure, final guard, and unresolved-intent checks with the same inputs. Keep the atomic reservation authoritative and immediately before the exchange POST.

**Rule:** Observability on an order path must be hard-bounded, exactly-once for terminal outcomes, idempotent after terminalization, and safe to no-op after eviction.

**Why:** A stalled or delayed candidate must never grow memory without limit, and telemetry must never throw inside the trading path or overwrite an unknown-exposure outcome.

**How to apply:** Bound active plus completed records together, evict safely, and make every late lifecycle update return without affecting order execution.