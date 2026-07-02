---
name: Position-relative NO gate
description: Block NO bets when live price is already above Kalshi strike by >0.1% unless ML confirms reversal
---

## The Rule
When `decision.action === "BET_NO"` AND `livePrice > kalshiStrike × 1.001` (>0.1% above strike):
- **Allow** only if `mlAbove === false` (ML confirms reversal) OR `signalsAgreeing >= 3` (broad agreement)
- **Skip** otherwise — log reason as `"NO gate — price +X% above strike, requires ML or 3-signal agreement"`

**Why:** Historical analysis showed 7/7 NO losses when the snapshot price was already above the Kalshi strike at entry time. These are mean-reversion calls into a trending market. Stat + Claude are prone to calling NO based on overbought indicators, but the trend continues. The ML model (trained on labeled window outcomes) is better at recognizing trending vs. reverting regimes.

**How to apply:** The gate lives in `kalshi-bot.ts` Phase 3 evaluation loop (after the YES confidence floor, before the window-doubt filter). Uses `getCachedPrediction(sym)?.price` for live price (now always non-null after the predCache tracker fix) and `kalshiData.value` for the strike.

## Constants
- `ABOVE_STRIKE_NO_GAP = 0.001` (0.1%) — the threshold above which the gate activates
- Gate requires `mlAbove === false` (ML's binary direction) OR `signalsAgreeing >= 3`
- `signalsAgreeing` counts {stat, claude, ml, wm} signals pointing in the decision direction

## Context
- The two fixes (predCache + NO gate) work together: predCache fix ensures ML is always available; NO gate uses ML as primary reversal confirmation
- If ML is unavailable (e.g., fresh restart before first snap), `signalsAgreeing >= 3` still provides an escape valve when window monitor also agrees
