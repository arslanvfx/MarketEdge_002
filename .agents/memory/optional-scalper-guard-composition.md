---
name: Optional Scalper guard composition
description: How additive Scalper safety layers compose with established fail-closed entry guards.
---

An optional additive Scalper guard may reject an entry when it positively detects its configured risk, but its own warming, cadence gap, or unavailable history must not veto an entry that passes the established guards.

Coordinated direction clearance may admit a flat or monotonically favorable target-side window without waiting for the meaningful-movement minimum, but only when there was no adverse tick or reset and projected target distance remains beyond the enabled proximity threshold.

**Why:** Treating an optional excursion layer as mandatory made the core Scalper path effectively unusable. Separately, requiring positive oracle movement in an already stable, safely target-side commodity window delayed submission until the marketable Kalshi liquidity had been swept.

**How to apply:** Keep target-side, wrong-way streak/reset, rapid-move, proximity, identity, and execution failures fail-closed. A noisy or net-adverse window still needs meaningful favorable recovery. Evaluate optional additive signals independently and re-check positive detections at every paper/live submit boundary.