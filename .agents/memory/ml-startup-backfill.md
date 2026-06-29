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

## Deduplication guard
- Guard: if a coin's `windows >= MIN_TRAINING_WINDOWS` after `initMLFromDB`, it's skipped. After the first successful backfill, the persisted model state + DB rows mean subsequent restarts always skip.
- No unique constraint on `window_id` in `ml_window_snapshots` — dedup is entirely via the in-memory guard.

**Why:** N_FEATURES bumps are expected when improving the model. Without backfill, every bump leaves users seeing "Training… 0/30" for hours.

**How to apply:** When bumping N_FEATURES again, the backfill runs automatically. Just ensure `extractMLFeatures` in `backtest.ts` uses the same signature as in `ml-features.ts` (it does — both call the same function).
