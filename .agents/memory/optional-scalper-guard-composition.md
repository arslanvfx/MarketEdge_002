---
name: Optional Scalper guard composition
description: How additive Scalper safety layers compose with established fail-closed entry guards.
---

An optional additive Scalper guard may reject an entry when it positively detects its configured risk, but its own warming, cadence gap, or unavailable history must not veto an entry that passes the established guards.

**Why:** Treating an optional excursion layer as a mandatory prerequisite caused otherwise eligible live entries to abort before submission for `adverse_excursion_unavailable_warming`, making the core Scalper path effectively unusable.

**How to apply:** Evaluate established directional, rapid-move, proximity, identity, and execution guards with their existing fail-closed semantics. Evaluate optional additive signals independently; fail open only for that signal's unavailability, and re-check positive detections at every paper/live submit boundary.