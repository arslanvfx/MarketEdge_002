---
name: Authoritative publication continuity
description: Safety rule for carrying authenticated provider updates into execution guards without manufacturing local cadence.
---

Execution-critical market-data services must retain a bounded ordered history of authenticated provider publications, not only the latest value. Consumers drain all unseen publications and deduplicate by provider publication identity; repeated local reads never become new movement evidence.

**Why:** A latest-only service silently drops genuine websocket updates whenever the one-second sampler or event loop is delayed. The guard then sees artificial multi-second gaps or too few distinct publications and fail-closes every otherwise eligible entry even though the authenticated stream remained healthy.

**How to apply:** Record provider publication time and original process receipt time at websocket arrival. Replace corrections for the same provider publication instead of appending them, ignore older publications, and clear both latest and retained history on malformed data, disconnect, reconnect, or generation retirement. Preserve current-window ownership when asynchronously publishing a drained batch. Keep stale, genuinely gapped, out-of-order, flat, and adverse evidence fail-closed, including the final broker-boundary recheck.