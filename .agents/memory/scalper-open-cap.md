---
name: Scalper operator-owned open cap
description: The required open-exposure cap is manually controlled and must not have an application ceiling.
---

The Scalper open-exposure cap remains mandatory, but every positive finite amount entered by the operator must be persisted and enforced exactly. The $50 constant is only the conservative default for a missing or invalid legacy value; it is not a maximum.

**Why:** The operator explicitly needs to raise simultaneous Scalper exposure above $50 and does not want a hidden UI, parser, normalization, or execution clamp changing the chosen value.

**How to apply:** Do not add an HTML maximum, client-side clamp, API upper-bound validation, or runtime normalization ceiling for `openCapDollars`. Keep the atomic open-exposure claim and all independent controls such as daily spend, available balance, per-order sizing, and final execution guards.

Confirmed filled or Paper positions count toward open exposure only while their own 15-minute market window is active. A delayed Kalshi settlement result must not consume future-window headroom. Indeterminate `submitting`/`unknown` orders and reserved intent budget remain fail-closed across windows.

**Why:** Once a short-window market has closed, its directional exposure is fixed even if Kalshi delays publishing the result. Treating settlement lag as open market risk can freeze later opportunities; relaxing truly unknown submissions could instead permit accidental overexposure.

**How to apply:** Scope `filled`/`paper` open-exposure totals to the active window key, while continuing to count unresolved submissions and reservations globally. Daily spend still counts the confirmed fill regardless of settlement timing.

An `open_cap_exceeded` denial is transient when the counted exposure comes from other candidates' pre-submit reservations. Re-arm that candidate after a short cooldown and make it repeat the same atomic claim-and-cap transaction; do not loosen the cap or bypass final guards. Daily-cap denials remain terminal.

**Why:** Parallel candidates can temporarily reserve all headroom while performing final checks, then release it without placing orders. Treating the first denial as terminal starves otherwise eligible candidates even though capacity becomes available seconds later.

**How to apply:** Persist the denial with zero reserved budget, schedule the shared bounded retry lifecycle, and rely on the per-mode advisory lock plus claim-time window check to prevent over-cap or late submissions. Unknown/submitting exposure remains non-retryable and fail-closed.