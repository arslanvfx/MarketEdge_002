---
name: EV gate direction asymmetry
description: The EV gate must run AFTER direction is decided and use direction-correct payoff formulas — applying the YES formula pre-direction kills cheap NO bets.
---

## The Bug Pattern

Pre-direction EV gates that use `(1−p)/p` as the payoff always compute YES contract returns.
For a NO bet at yes_price=0.92 (NO costs 8¢), the correct payoff is `0.92/0.08 = 11.5×`.
The YES formula gives `0.08/0.92 = 0.087×` — 130× too pessimistic — and blocks the bet.
Conversely, expensive NO contracts at low yes_price appear to have huge payoff (uses 1−p/p)
when the real NO payoff is tiny — those bad bets slip through.

## Direction-Correct Formulas

```
BET_YES: EV = acc × (1−p)/p − (1−acc)    // pays p, wins (1−p)
BET_NO:  EV = acc × p/(1−p) − (1−acc)    // pays (1−p), wins p
```

Implemented in `computeEVForDirection(action, yesPrice, signalAccuracyPct)` in
`kalshi-bot-engine-core.ts`. Called inside `computeCorePairDecision` (the public
wrapper) AFTER `computeCorePairDecisionUngated` produces a direction.

## Architecture Note

- `computeCorePairDecisionUngated` still computes `ev` (YES formula) for the return
  value — used for display/logging.
- `computeCorePairDecision` applies the direction-correct gate. If it fires, it
  overwrites `ev` in the result with `dirEV` so the UI shows the correct number.
- Gate threshold: −0.05 (unchanged).
- null yesPrice or null signalAccuracyPct → `dirEV=null` → gate skipped (same as before).

## Symmetry Verification

At yes_price=0.50, both formulas are identical (symmetric market):
`acc × 1 − (1−acc)` for both YES and NO → equal treatment guaranteed.

**Why:** The old gate was added before the engine distinguished directions. Once the
engine moved to post-direction PATH A/B/C, the gate should have moved too.
