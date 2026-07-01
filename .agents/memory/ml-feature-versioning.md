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

## v3 feature set (N_FEATURES = 17, current)
Features 14-16 were added to make ML a true synthesis model:
- Feature 14 `statAbove`: stat model direction (1=above, 0=below, 0.5=unknown)
- Feature 15 `claudeAbove`: claude model direction (1=above, 0=below, 0.5=unknown)
- Feature 16 `wmRec`: window monitor (1=bet, 0=stay_away, 0.5=caution/unknown)

**Training distribution fix:** ML snapshot is captured AFTER stat+claude compute (in crypto.ts prediction tracker), not before. This means features 14-16 have real values at training time, matching inference (bot engine also passes live stat/claude/wmRec).

**Backfill:** v3 backfill (prefix `backfill_v3:`) queries prediction_records to populate features 14-15 from historical stat/claude records. Feature 16=0.5 (wmRec not stored historically). `hasLegacyBackfillRows` now detects both v1 and v2 as legacy (NOT LIKE `backfill_v3:`).

## Checklist for a feature bump
1. Change `N_FEATURES` in `ml-model.ts`
2. Add/update features in `ml-features.ts` (signature + FEATURE_NAMES + computation)
3. Update all `extractMLFeatures(...)` call sites to pass any new params
4. Bump backfill prefix (`backfill_vN:`) in `backtest.ts` and update `hasLegacyBackfillRows` in `ml-store.ts`
5. Update `ml-backfill.ts` augmentation if new features need historical data joins
6. Rebuild and confirm log shows `warming: X(0/30)` not `ready:`
