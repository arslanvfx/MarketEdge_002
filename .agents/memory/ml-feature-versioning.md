---
name: ML feature versioning
description: How to safely bump N_FEATURES and avoid the "ready with random weights" trap
---

## The rule
`N_FEATURES` is defined in `ml-model.ts` — that is the single authoritative constant used by `ml-core.ts`, `ml-store.ts`, and tests. `ml-features.ts` exports its own `N_FEATURES` only for the UI/route layer; they must be kept in sync manually.

**Why:** `ml-core.ts` imports from `ml-model.ts`, not `ml-features.ts`. Changing only `ml-features.ts` leaves the core guard checks (`applyLabeledSnapshot`, `applyHydratedModel`) using the old size → old examples are NOT discarded and old weights ARE applied, causing silent prediction corruption.

## The reset-on-mismatch fix (applied)
`applyHydratedModel` resets **both** `s.weights` and `s.windows` to zero when `weights.length !== N_FEATURES + 1`. Previously it only reset weights, leaving a stale window count that made the model appear "ready" while running on random weights.

**How to apply:** Any time you bump N_FEATURES, restart the server — the hydration log will show `warming: X(0/30)` for all coins confirming a clean reset. If it shows `ready: X(63%)` instead, the build cached stale code.

## Checklist for a feature bump
1. Change `N_FEATURES` in `ml-model.ts`
2. Add/update features in `ml-features.ts` (signature + FEATURE_NAMES + computation)
3. Update all `extractMLFeatures(...)` call sites to pass any new params
4. Update `ml-core.test.ts` if any test uses hardcoded weight-vector length
5. Rebuild and confirm log shows `warming: X(0/30)` not `ready:`
