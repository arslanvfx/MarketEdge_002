---
name: Scalper real-time direction guard
description: Strict streak and full-window favorable-trend protection for final-window Scalper entries.
---

The real-time direction guard has two additive checks over the same complete, fresh, cadenced window:

1. Preserve the strict consecutive wrong-way *elapsed-time* streak. YES treats falling as wrong-way; NO treats rising as wrong-way. Flat or favorable ticks reset only this strict streak.
2. Independently require default-on favorable net movement across the complete window. YES must finish strictly higher and every selected sample must stay above target; NO must finish strictly lower and every selected sample must stay below target. Flat or net wrong-way endpoints, equality with the target, and target crossings block even when the final sample is back on the winning side. Disabling this confirmation restores legacy strict-streak behavior plus the original latest-sample target-side check.

**Why:** Sample count alone can shorten the safety period, while one flat or favorable interruption can reset a strict streak even though the overall move remains adverse. The two checks prevent both failure modes without changing established streak semantics.

**How to apply:** Keep the duration and confirmation toggle operator-adjustable. Fail closed on missing, stale, gapped, out-of-order, insufficient, or target-side-invalid data. Pin both settings for an attempt and synchronously re-evaluate already-collected in-memory samples after intent persistence, immediately before submission, with no new network I/O or await after a successful decision. Persist signed movement, confirmation status, and strict reset evidence. Rapid-move avoidance remains an independent, separately controlled filter.