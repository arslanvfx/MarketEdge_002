---
name: Operator-owned risk caps
description: Financial cap settings must remain operator-controlled without arbitrary hard-coded ceilings.
---

Financial caps and budget values must accept any finite non-negative value selected by the operator. Keep domain constraints that are intrinsic to the exchange or data type, but do not add arbitrary UI or API maximums to dollar-denominated risk controls.

**Why:** A hard-coded ceiling prevented the operator from setting total exposure to the intended value, and silent API rejection made the saved configuration misleading.

**How to apply:** For dollar caps such as total exposure, validate numeric finiteness and the meaningful lower bound only. Keep frontend and backend validation aligned, and return an explicit validation error rather than silently ignoring invalid input.