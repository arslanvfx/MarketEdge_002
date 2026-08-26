---
name: Conviction entry fast-path invariants
description: Durable identity, I/O-coalescing, and final-safety rules for low-latency conviction entries.
---

# Conviction entry fast-path invariants

## Keep market identity immutable

**Rule:** The exact market ticker and strike from one forced-fresh response travel together through dispatch and final validation. Reject missing, invalid, or mismatched identity before submission.

**Why:** Combining a current-window ticker with a strike read later from a mutable cache can validate and submit against different markets.

**How to apply:** Treat ticker and strike as one snapshot. Never reread one member from another cache after dispatch.

## Coalesce prepared network work

**Rule:** Final entry code joins exact-key work already started during the waiting period. Completed failures and bounded timeouts remain recognizable briefly so they cannot trigger an immediate duplicate request.

**Why:** Fire-and-forget preparation can race the final path; deleting failed work immediately causes a second slow request and increases rate-limit pressure.

**How to apply:** Key preparation by immutable market identity, retain its outcome for a short TTL, and route timeout/failure through the existing strict fallback rather than retrying on the hot path.

## Preserve the final safety boundary

**Rule:** Preparation may remove avoidable I/O, but fresh quote validation, fail-closed proximity and wrong-side movement checks, atomic durable reservation, and IOC/FOK submission remain ordered immediately before exposure.

**Why:** Moving volatile evidence or ownership claims too early improves latency by weakening safety.

**How to apply:** Precompute only non-volatile evidence; rerun lifecycle-bounded market checks and claim shared exposure atomically at the final boundary.