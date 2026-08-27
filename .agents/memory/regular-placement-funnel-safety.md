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

**Rule:** A regular conviction candidate may consume only prewarmed, exact-ticker orderbook routing and exact-route account evidence. After eligibility, the only permitted await before the broker POST is the durable intent claim; DDL and market, orderbook, or balance reads must never occur there.

**Why:** Candidate-time network preparation caused eligible live orders to miss short price windows. Rechecking funding only before the durable claim also allowed another fill to invalidate the evidence while the claim was waiting.

**How to apply:** Compute one immutable worst-case cost from the final submitted limit and refreshed count, use it for route funding and intent reservation, and synchronously revalidate authorization plus that same prepared funding immediately before the POST. Missing or invalidated evidence fails closed without I/O.