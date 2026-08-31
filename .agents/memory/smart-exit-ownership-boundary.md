---
name: Smart Exit ownership boundary
description: Durable safety rules for analysis-driven early exits across regular and Scalper positions.
---

Smart Exit owns evidence, probability analysis, recommendations, and audit history only. It never owns positions or broker mechanics. Any actionable exit must delegate through the position owner's durable close lifecycle, after exact identity, mode, applied-version, and evidence checks are repeated immediately before submission. Emergency disable must be able to revoke a request after durable claim but before the broker call.

The operator-selected built-in policy is itself a complete executable parameter version. A missing calibrated override must fall back to that built-in version rather than block every paper/live exit. When a calibrated override exists, its immutable snapshot, scope, and live eligibility remain mandatory.

A live recommendation must freeze its economic floor and evidence-expiry deadline at decision time. The owner must re-fetch authenticated depth, prove the full quantity remains executable at that immutable winning-side floor, and submit a side-aware bounded FOK limit. Never recompute the floor from mutable config after an await or use an unreferenced aggressive close.

For an independent reducing subsystem, ownership begins when its lifecycle is claimed—not when a broker request row is later inserted. That owner must block every execution mode and remainder until authoritative reconciliation proves zero or an exact partial remainder. A synchronous submit response never proves terminal fill accounting; keep it unresolved until authenticated history matches the complete immutable request identity. Evidence fetch latency must use the policy's typed time unit and fail closed.

A final pre-submit failure is not exchange exposure. Preserve its audit lifecycle, release its active-owner status, and allow a later fresh trigger to claim a new lifecycle. Never release ownership this way after a durable broker request exists; submitted or unknown requests stay blocking until authoritative reconciliation.

Smart Exit request deduplication must distinguish no-sale outcomes from exposure.
Blocked pre-submit attempts and confirmed zero fills may atomically retry under a
new fresh signal; requested, unknown, and filled attempts remain locked. Filled
and unknown lifecycle states are monotonic against stale concurrent writers, and
durable sale time plus a valid confirmed fill price is authoritative evidence
that a legacy lifecycle is filled.

**Why:** A one-row-per-position request ledger once treated the first transient
depth block as a permanent duplicate, preventing later exit attempts. A stale
concurrent retry also overwrote a confirmed fill as blocked, making a successful
sale appear to have failed.

**How to apply:** Permit claim replacement only with an atomic conditional write
whose prior status proves no sale (`blocked` or `zero_fill`). Never unlock
`requested`, `unknown`, or `filled`; protect terminal lifecycle writes at the
database boundary and normalize retained confirmed-fill evidence on reads.

Scalper exit depth is complementary exposure, while its economic floor is original-side proceeds. Original YES exits inspect NO depth; original NO exits inspect YES depth. Convert every depth price with `1 - price` before testing the frozen floor, weighting proceeds, or reporting shadow/paper value.

After proving exact full-quantity depth, the dedicated live exit must submit FOK, not IOC. Authenticated reconciliation still owns accepted or unknown outcomes, but partial-fill-capable TIF would invalidate the subsystem's all-or-nothing economic guarantee.

**Why:** Analysis can become stale while durable ownership is being claimed. A gap between lifecycle claim and request insertion can admit a second mode or remainder. Exchange acknowledgements can omit or misstate eventual fills, unit drift can disable a live safety gate, and treating optional calibration as mandatory once blocked every baseline exit.

**How to apply:** Regular positions use their canonical regular close lifecycle. Scalper exits use a dedicated, mode-independent reducing owner keyed to the original Scalper position, exact authenticated order-and-fill reconciliation, converted complementary depth, FOK submission, and exact unsold-remainder accounting. Claim broker-request attempts only after final evidence and policy revalidation; pre-submit blocks may release the lifecycle, post-submit ambiguity may not. Recovery scalps remain counterfactual research and never submissions.

Current evaluations must be scoped twice: `live-exit` sees live positions only and `paper-exit` sees paper positions only; the regular dashboard displays regular-owner evaluations only, while Scalper-owner evaluations stay in the dedicated Scalper panel.

**Why:** Regular paper and live positions share one in-memory map, and Smart Exit once evaluated both even while the bot dashboard correctly showed only the selected mode. This made one live position appear as three active exits; shared Scalper evaluations could further inflate the regular count.

**How to apply:** Filter positions before evidence collection and evaluation, clear cached current evaluations on mode changes, and derive the regular UI count/table from regular-owner rows rather than global Smart Exit health totals.