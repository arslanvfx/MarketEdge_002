---
name: Scalper real-time direction guard
description: Strict streak, full-window trend protection, and tightly scoped coordinated clearance for final-window Scalper entries.
---

The real-time direction guard has two additive checks over the same complete, fresh, cadenced window:

1. Preserve the strict consecutive wrong-way *elapsed-time* streak. YES treats falling as wrong-way; NO treats rising as wrong-way. Flat or favorable ticks reset only this strict streak.
2. Independently require default-on favorable net movement across the complete window. YES must finish strictly higher and every selected sample must stay above target; NO must finish strictly lower and every selected sample must stay below target. Flat or net wrong-way endpoints, equality with the target, and target crossings block even when the final sample is back on the winning side. Disabling this confirmation restores legacy strict-streak behavior plus the original latest-sample target-side check.
3. An operator may explicitly enable coordinated direction clearance. It may soften only the full-window net-trend rejection: YES projects an adverse fall and NO projects an adverse rise at the pace measured across the directional window, through the actual seconds remaining. The projected endpoint must remain strictly beyond the enabled target-distance buffer. The setting defaults off.

**Why:** Sample count alone can shorten the safety period, while one flat or favorable interruption can reset a strict streak even though the overall move remains adverse. Coordinating pace, remaining time, and distance allows materially safe slow drifts without weakening hard safety boundaries.

**How to apply:** Fail closed on missing, stale, gapped, out-of-order, insufficient, or target-side-invalid data. Coordinated clearance must never override the strict wrong-way streak, enabled rapid-move avoidance, target-side validation, or target-distance failure. Use only the directional-window span as the adverse-pace denominator; a longer rapid-move lookback must not dilute pace. Pin every setting for an attempt and synchronously re-evaluate after intent persistence with no await after a successful decision. Persist evidence from the decisive paper/live recheck through normal finalization, abort, unknown, and reconciliation paths.