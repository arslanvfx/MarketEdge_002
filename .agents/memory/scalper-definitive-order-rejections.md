---
name: Scalper definitive order rejections
description: Safety boundary between proven Kalshi order rejection and potentially accepted live exposure.
---

Only a verified client rejection can resolve a Scalper submission as zero fill without exchange-history matching. Client responses such as `400`, `401`, `403`, or `404 market_not_found` prove the order was rejected; a `409` is safe only for the explicit insufficient-resting-volume code.

Transport failures, invalid success bodies, `5xx`, `408`, `425`, `429`, and generic or duplicate-client-ID `409` responses remain unknown exposure. They must retain the reservation, trip or preserve the circuit breaker, and require authoritative reconciliation.

Persisted historical error text may repair an old unresolved row only when it contains the same definitive HTTP evidence. The repair must use the normal atomic reconciliation transaction and preserve its sibling-order checks.

**Why:** Kalshi can reject an invalid ticker with `404 market_not_found`, which means no order exists to find in history. Treating that proof as ambiguous creates an impossible reconciliation loop, while broadly treating HTTP failures as zero fills risks duplicate live exposure.

**How to apply:** Classify the HTTP response at the Scalper-owned exchange boundary, carry definitive rejection as typed evidence, and resolve it before the generic unknown-exposure branch. Keep every non-definitive case fail-closed.