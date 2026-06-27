---
name: ML pipeline architecture
description: Self-learning logistic regression pipeline for Kalshi ABOVE/BELOW prediction — file layout, data flow, training gate, and key decisions.
---

## File layout
- `artifacts/api-server/src/lib/ml-features.ts` — pure feature extraction, no DB
- `artifacts/api-server/src/lib/ml-model.ts` — pure logistic regression (SGD + L2), no DB
- `artifacts/api-server/src/lib/ml-store.ts` — orchestrator: capture/label/retrain/persist; imports both above + `@workspace/db`
- `lib/db/src/schema/mlTables.ts` — `ml_window_snapshots` + `ml_model_state` tables

## Data flow
1. Each tracker tick: snap section calls `captureMLSnapshot(sym, targetISO, features, elapsed)` once per window when `kalshiTargetSnap != null`
2. Evaluation section: when stat record is evaluated with Kalshi target, calls `labelWindowAndRetrain(sym, rec.targetTime, outcome)`
3. Retrain: after each label, runs 25 SGD epochs over up to 6k most recent examples, evaluates val accuracy on last 200, persists weights to DB
4. Startup: `initMLFromDB()` reloads labeled snapshots + weights; called in parallel with `initHistoryFromDB()`

## Feature vector (12 features, all normalized)
`[elapsedFraction, priceVsStrikeNorm, aboveStrike, efficiencyRatio, bbPctBNorm, rsiNorm, netDriftNorm, oscillationNorm, spikeFlag, strikeProximityNorm, atrNorm, momentumDir]`

## Training gate
`MIN_TRAINING_WINDOWS = 30` — endpoint returns `ready:false` and `above:null` until met.

## API endpoint
`GET /api/crypto/ml-prediction/:symbol` — returns `{above, confidence, prob, ready, windows, samples, minWindows, valAccuracy}`; no prediction data when `!ready` or no Kalshi series for the coin.

**Why:** The model only predicts when it has a Kalshi target (strike price) — that's the binary label. Coins without a Kalshi series never accumulate labeled windows and thus never become ready.

## Frontend
- `MLPredResponse` interface in predictor.tsx
- `mlPredQuery` refetches every 30s (tracker tick rate)
- 4-column grid: `grid-cols-2 sm:grid-cols-4` — Stat | Claude | Auto-Pilot | ML Model
- ML card: sky-blue theme, training progress bar when `!ready`, direction+conf when ready
- ML chip: styled sky-300, shows val accuracy annotation in parens
- Added to `consensusSignals` array when `mlPred.ready && mlPred.above !== null`
