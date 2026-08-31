---
name: Kalshi CF crypto feed identity
description: Non-obvious identity and lifecycle rules for Kalshi's settlement-aligned CF Benchmarks crypto feed.
---

Kalshi market rules print CF index identifiers without an underscore (for example, `ZECUSDRTI`), while the `cfbenchmarks_value` websocket uses identifiers with an underscore (for example, `ZECUSD_RTI`). Bitcoin is the exception: both use `BRTI`. Treat these as two explicit identities for the same feed rather than normalizing strings ad hoc.

**Why:** A subscription using the settlement-rule identifiers was accepted but silently delivered only Bitcoin. The authenticated channel's actual index list exposed the underscore-form identifiers for the other crypto assets.

**How to apply:** Validate active markets against the exact quoted settlement-rule identifier, but subscribe, index, and deduplicate websocket evidence with the channel identifier. Preserve source timestamps and publication sequence; repeated local reads are not new market movement. Bind callbacks and warm-up writes to the exact socket generation so retired connections cannot repopulate current guard evidence.

Execution and Smart Exit may use only authenticated websocket provenance. Public
Kalshi event-live-data warm-up can support reconnect visibility, but it must
never satisfy an execution-critical read. Require both source publication time
and local receipt time to be fresh before creating an entry baseline or making
an exit/hold decision.

**Why:** A settlement-aligned public warm-up and a fresh-source/stale-receipt
publication can otherwise look valid while bypassing the authenticated
real-time transport guarantee, allowing delayed evidence to persist in a model
baseline and influence a later exit.

**How to apply:** Keep warm-up provenance distinct and fail closed until a live
authenticated publication arrives. Apply the same source-and-receipt freshness
predicate at baseline capture, ongoing evaluation, and final revalidation.