---
name: ML startup backfill
description: How the model recovers immediately after an N_FEATURES bump without waiting 7h for live windows.
---

## The rule
After any N_FEATURES bump, models reset to 0/30. The backfill runs automatically on every server start and recovers them in ~17 seconds.

## How it works
1. `startPredictionTracker(onInitComplete?)` in `crypto.ts` accepts an optional callback called once inside `Promise.all([initHistoryFromDB, initMLFromDB]).finally(...)`.
2. `index.ts` passes `() => runMLBackfillIfNeeded(96)` as that callback.
3. `ml-backfill.ts`: `runMLBackfillIfNeeded(windowCount=96)` calls `getAllMLStatus()`, finds coins with `windows < MIN_TRAINING_WINDOWS (30)`, and calls `generateMLTrainingExamples({coins, windows})`.
4. `backtest.ts`: `generateMLTrainingExamples()` runs `runRawBacktest()`, extracting the 14-dim feature vector for each window via `extractMLFeatures(cp, openPrice, 0.05, openPrice)` (elapsed=0.05 ≈ window open, drift=0). Returns `MLTrainingExample[]`.
5. `ml-store.ts`: `backfillFromExamples(examples)` loads all examples in-memory via `applyLabeledSnapshot`, batch-inserts to DB in chunks of 200, then `reconcileStateFromExamples` + `persistModelState` per coin.

## Deduplication / version guard
- **v2 prefix** (`backfill_v2:BTC:...`): new backfill rows; `hasLegacyBackfillRows()` queries for `backfill:%` NOT `backfill_v2:%`.
- On startup: if v1 rows detected → `clearMLData()` (wipes DB + `resetAllState()`) → re-runs improved backfill.
- After first successful v2 backfill, subsequent restarts load v2 rows → windows ≥ 30 → backfill skipped.
- No unique constraint on `window_id` — dedup is via the in-memory guard (windows ≥ 30 → skip) + prefix versioning.

## Critical lesson: backfill feature distribution must match live inference
v1 backfill always used `elapsed=0.05, priceAtOpen=openPrice` → features 1, 2, 12 were ALWAYS ≈ 0 in training.
Live inference queries at any elapsed fraction with real price movement → model couldn't react.
**Fix**: `backtestCoin` now picks the T+7min candle (elapsed≈0.47, snapPrice=midCandle.c) for features.
The synthetic CoinPrediction passed to `extractMLFeatures` has `price = snapPrice` but keeps pre-window `indicators` and `candles`.

**Why:** N_FEATURES bumps are expected when improving the model. Without backfill, every bump leaves users seeing "Training… 0/30" for hours. Without correct feature distribution, the model gives wrong predictions indefinitely.

**How to apply:** When bumping N_FEATURES again, the backfill auto-runs. Ensure the backfill's feature snapshot point (currently T+7min) produces realistic variance in all 14 features — especially the strike-relative features (1, 2) and window-drift (12).
