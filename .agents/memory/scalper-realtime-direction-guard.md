---
name: Scalper real-time direction guard
description: Strict streak, full-window trend protection, and tightly scoped coordinated clearance for final-window Scalper entries.
---

The real-time direction guard has two additive checks over the same complete, fresh, cadenced window:

1. Preserve the strict consecutive wrong-way *elapsed-time* streak. YES treats falling as wrong-way; NO treats rising as wrong-way. Flat or favorable ticks reset only this strict streak.
2. Independently require default-on favorable net movement across the complete window. YES must finish at least 0.00005% higher and every selected sample must stay above target; NO must finish at least 0.00005% lower and every selected sample must stay below target. Flat, duplicate-only, sub-floor, or net wrong-way endpoints, equality with the target, and target crossings block even when the final sample is back on the winning side. Disabling this confirmation restores legacy strict-streak behavior plus the original latest-sample target-side check.
3. Coordinated direction projection is diagnostic only. It may show that a projected endpoint retains the target-distance buffer, but it cannot override the hard favorable-movement minimum.

**Why:** Sample count alone can shorten the safety period, while one flat or favorable interruption can reset a strict streak even though the overall move remains adverse. A live SILVER loss showed that a +0.00003% noise rebound could otherwise count as favorable. Production replay selected 0.00005% to reject that incident while preserving meaningful low-volatility updates.

**How to apply:** Fail closed on missing, stale, gapped, out-of-order, insufficient, duplicate-only, sub-floor, or target-side-invalid data. Only execution-authoritative sampling bypasses the shared ticker cache; background, Shadow, and Contrarian lanes retain their own cached policy. Use only the directional-window span as the adverse-pace denominator; a longer rapid-move lookback must not dilute pace. Pin every setting for an attempt and synchronously re-evaluate after intent persistence with no await after a successful decision. Persist the minimum, unique-price count, and decisive paper/live evidence through normal finalization, abort, unknown, and reconciliation paths.