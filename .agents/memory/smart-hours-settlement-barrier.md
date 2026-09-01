---
name: Smart Hours settlement barrier
description: Why hourly per-market schedule calibration must follow completed outcome evaluation.
---

Hourly Smart Hours calibration must run after a short settlement grace and must serialize the full evaluate-then-calibrate sequence across timer, recovery, startup, and manual callers. Never commit the current-hour marker while selected closed bets remain unresolved.

**Why:** Calibrating exactly on the hour races outcome settlement. The schedule query then misses just-closed bets but still suppresses another automatic pass for the entire hour, while a later manual refresh appears to “fix” availability. A single evaluation batch is also insufficient after downtime.

**How to apply:** Coalesce outcome evaluation, drain all progressing batches, require the final automatic batch to be fully evaluated, and leave the marker stale on deferral, failure, or bounded overflow so recovery retries.