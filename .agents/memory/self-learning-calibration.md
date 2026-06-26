---
name: Self-learning calibration core (crypto)
description: How crypto prediction records self-calibrate confidence, bucket bias by regime, and expose analytics — and the circularity trap to avoid.
---

## What this covers
The crypto predictor learns from its own evaluated history (in `artifacts/api-server/src/lib/crypto.ts`): it remaps Claude's reported confidence onto observed reliability, computes signed bias bucketed by market regime, and exposes a read-only analytics endpoint.

## Rules / invariants

- **rawConfidence vs confidence (circularity trap):** A prediction record stores BOTH the model's reported confidence (`rawConfidence`) and the calibrated value actually shown/scored (`confidence`). The reliability curve and `calibrateConfidence()` MUST bucket on `rawConfidence` (fallback to `confidence` for rows without it). If you ever learn the curve from `confidence`, calibration feeds on its own output and collapses.
  **Why:** calibrated confidence is a function of past hit rates; feeding it back in makes the mapping a fixed-point of itself, not of reality.
  **How to apply:** any new calibration/reliability computation reads `rawConfidence ?? confidence`, never `confidence` alone.

- **Regime is reconstructed from a stored input, not stored as a label:** records persist `efficiencyRatio` at snapshot time; regime is derived on read via `regimeFromER()` (ER≥0.55 trending, ≥0.25 drifting, else choppy — the SAME thresholds the prompt shows Claude in `intraWindowBlock`). "spike" is a separate flag, not one of these regimes.
  **Why:** keeps stored records bucketed into exactly the regimes Claude reasoned about, and lets thresholds change later without a migration.
  **How to apply:** rows written before this feature shipped have `efficiencyRatio = null` → they are excluded from regime buckets (correct) and only count in all-regime fallbacks.

- **Bias bucketing falls back coarser → all-regime when thin:** `computeSignedBias(symbol, {regime})` uses the regime bucket only when it has ≥3 records, else all-regime. Still Claude-only (stat records would poison Claude's self-assessment — see crypto-bias-calibration.md).

- **Calibration is gentle:** `calibrateConfidence()` passes raw through unchanged below a min sample count per band, then shrinks toward the band's observed hit rate with weight n/(n+K). Always clamped to the display range 20–92.

- **Both Claude paths calibrate identically:** the stored tracker path (`refineSnappedPrediction` → record build) and the on-demand display path (`callClaudeForPredictions` return) both call `calibrateConfidence`, so shown and scored confidence stay consistent.

## Surface
Read-only endpoint `GET /api/crypto/prediction-analytics` (routes mounted under `/api`) returns per-coin `{bySource, byRegime, calibration}`. Brier in `metricsFor` is over the binary correct/incorrect outcome vs stored confidence.
