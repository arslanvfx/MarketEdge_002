---
name: Scalper definitive order rejections
description: Safety boundary between proven Kalshi order rejection and potentially accepted live exposure.
---

Only a verified client rejection can resolve a Scalper submission as zero fill without exchange-history matching. Client responses such as `400`, `401`, `403`, or `404 market_not_found` prove the order was rejected; a `409` is safe only for the explicit insufficient-resting-volume code.

Transport failures, invalid success bodies, `5xx`, `408`, `425`, `429`, and generic or duplicate-client-ID `409` responses remain unknown exposure. They must retain the reservation, trip or preserve the circuit breaker, and require authoritative reconciliation.

Persisted historical error text may repair an old unresolved row only when it contains the same definitive HTTP evidence. The repair must use the normal atomic reconciliation transaction and preserve its sibling-order checks.

**Why:** Kalshi can reject an invalid ticker with `404 market_not_found`, which means no order exists to find in history. Treating that proof as ambiguous creates an impossible reconciliation loop, while broadly treating HTTP failures as zero fills risks duplicate live exposure.

**How to apply:** Classify the HTTP response at the Scalper-owned exchange boundary, carry definitive rejection as typed evidence, and resolve it before the generic unknown-exposure branch. Keep every non-definitive case fail-closed.

Kalshi event markets may be assigned to a nonzero `exchange_index`. The V2
order request must carry the index from the same successful, forced-fresh
market identity lookup used at the final execution boundary. A fulfilled
refresh that returns no target is still a refresh failure; never reuse the
older cached ticker, close time, or exchange index to authorize submission.

**Why:** Kalshi's documented ticker auto-routing returned `404
market_not_found` for live markets on exchange shard 2 while shard-0 orders
continued filling. The markets existed and their market payloads identified
the correct shard.

**How to apply:** Parse only nonnegative integer exchange indexes, preserve
shard 0, fail closed before intent creation when the forced refresh or routing
identity is missing, and include `exchange_index` in every strict Scalper and
Contrarian V2 order request. Same-lifecycle retries must refresh and repin it.

Stale pre-submit reservations may be released only when they are old, still
`claimed`, retain budget, and have no matching order-intent row. Cleanup and
intent creation must share the same cap advisory lock; intent creation must
lock and revalidate that the reservation remains claimed with positive budget.
If cleanup wins, later intent creation must fail before any broker POST.