---
name: Proximity gate calibration for conviction mode
description: Why the per-coin thresholds and ATR multiplier cap matter; what values to use
---

## Rule
`PROXIMITY_THRESHOLD_SUGGESTIONS` are the code-level defaults when no per-coin override or global value is configured. They must be calibrated for conviction mode (not non-conviction).

In conviction mode, Kalshi prices at 82–90¢ means the crypto price is naturally near the Kalshi strike. Typical `gapPct` values are 0.01–0.05%. Pre-calibration suggestions (0.10–0.28%) blocked every entry; recalibrated values (0.02–0.05%) allow bets while still filtering zero-gap entries.

**Calibrated values (as of this change):**
- BTC: 0.02%, ETH: 0.02%, XRP: 0.03%, BNB: 0.03%, SOL: 0.03%
- DOGE: 0.04%, NEAR: 0.04%, HYPE: 0.05%, ZEC: 0.05%
- Global fallback: 0.05% (down from 0.30%)

## ATR multiplier cap
`computeStrikeProximityGate` has an `atrMultiplierCap` parameter (default 2).
Without it, a coin with 1% ATR gets multiplier = 1.0/0.20 = 5×, turning a 0.03% threshold into 0.15% and blocking all conviction entries.
With cap=2, worst case is 0.03% × 2 = 0.06% — still meaningful but not lethal.

**Why:** Pre-rollback production code had this cap at 2; the rollback removed it silently.

## Priority chain in getEffectiveProximityThreshold
1. `config.strikeProximityMinPctOverrides[sym]` (user dashboard override — highest priority)
2. `PROXIMITY_THRESHOLD_SUGGESTIONS[sym]` (code-level calibrated default)
3. `config.strikeProximityMinPct` (global fallback)
4. Hard fallback: 0.05%

## Route validation bounds
`strikeProximityMinPct` and per-coin override values: minimum is 0.01% (lowered from 0.10%/0.05%).
