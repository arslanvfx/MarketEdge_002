---
name: Scalper final-minute fast path
description: Safety and telemetry constraints for keeping Scalper submission latency low near market close.
---

Serialize scans and coalesce overlap into one immediate follow-up pass instead of either overlapping work or dropping ticks. Begin non-submitting preflight 180 seconds before eligibility, using a lighter cadence early and a faster cadence near entry. Of three underlying-price fetch lanes, background sampling may occupy at most two so authoritative final guard sampling always has a lane; an already-running same-symbol background fetch may satisfy the authoritative request because it still returns a fresh sample.

**Why:** Final-minute candidates can leave the configured band while waiting behind a long scan, background sample backlog, or avoidable database round trips. Lower latency must not come from deleting safety checks or increasing uncontrolled concurrency.

**How to apply:** Keep the exact final identity refresh, authenticated orderbook, fresh Freefall/target-distance sample, final balance, advisory-locked daily/open cap claim, immutable risk revalidation, intent-before-live-POST, IOC cost ceiling, and strict unknown reconciliation. Claim aggregates may share one locked SQL round trip. Dashboard timing starts at cached-candidate detection, so it does not include time a scan request waited in the coalesced pending slot.