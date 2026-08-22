---
name: Scalper operator-owned open cap
description: The required open-exposure cap is manually controlled and must not have an application ceiling.
---

The Scalper open-exposure cap remains mandatory, but every positive finite amount entered by the operator must be persisted and enforced exactly. The $50 constant is only the conservative default for a missing or invalid legacy value; it is not a maximum.

**Why:** The operator explicitly needs to raise simultaneous Scalper exposure above $50 and does not want a hidden UI, parser, normalization, or execution clamp changing the chosen value.

**How to apply:** Do not add an HTML maximum, client-side clamp, API upper-bound validation, or runtime normalization ceiling for `openCapDollars`. Keep the atomic open-exposure claim and all independent controls such as daily spend, available balance, per-order sizing, and final execution guards.