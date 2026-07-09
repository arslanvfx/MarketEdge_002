---
name: Stock bot entry gates fail-closed
description: All stock bot entry gates (horizonGate, Level 1 quote gate) must block when data is missing, never pass on null.
---

Rule: every entry gate in the stock bot must be fail-closed — missing data blocks the entry with a SKIP decision, it never silently passes.

**Why:** Initial implementation had `volumeSurge != null && volumeSurge < 1.2` (null passed), `if (report && report.confidence < 60)` (no report passed swing gate), and the Level 1 quote gate only applied when quote fields were present. Architect review flagged all three as spec violations letting trades through that should be blocked.

**How to apply:** When adding any new entry condition (day/swing/long horizonGate, Level 1 spread/imbalance, or future gates), reject with an explicit reason when the required signal is null/undefined. Record the skip via recordDecision so the decision feed explains why.
