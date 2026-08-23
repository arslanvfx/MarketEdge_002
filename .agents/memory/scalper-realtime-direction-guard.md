---
name: Scalper real-time direction guard
description: Directional entry protection and independent rapid-move avoidance for final-window Scalper entries.
---

The directional guard measures a trailing, wrong-way *elapsed-time* streak using fresh, cadenced underlying prices after the eligibility boundary. It must not become clear or block early merely because jitter or extra fetches create enough samples; require the complete configured real-time duration. YES requires spot above target and blocks only a sustained fall toward it; NO requires spot below target and blocks only a sustained rise toward it. Flat or favorable movement resets the streak.

**Why:** Sample count alone can turn a nominal four-second safety period into roughly three seconds, especially under fast/jittered fetching. Pre-eligibility samples must never qualify a newly eligible entry.

**How to apply:** Keep the default duration operator-adjustable, fail closed on missing/stale/gapped/out-of-order/target-side-invalid data, and retain measured duration plus sample coverage in skip evidence. The optional rapid-move filter remains separate from directional logic and starts disabled; its blocks and unavailable states use the normal guard cooldown so a transient shock does not permanently forfeit the market window. Preserve the final-path rule that guard evaluation uses already-collected in-memory state and adds no post-check I/O.