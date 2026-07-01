---
name: ML-primary decision architecture
description: New signal priority order and the root cause of the ML null bug that caused ML to be skipped every bet.
---

## ML null root cause

`getCachedPrediction(sym)?.kalshiTarget` was always null because `CoinPrediction.kalshiTarget`
is populated by the prediction tracker independently of the Kalshi route cache. Fix applied in
`kalshi-bot-engine.ts`:

```ts
const mlKalshiTarget = pred?.kalshiTarget ?? getKalshiCachedData(sym)?.value ?? null;
```

**Why:** The two caches are set independently; never rely on only one for the strike value.

## New signal priority: ML → Claude → Stat

In `kalshi-bot-engine-core.ts`:

- **PATH A (ML primary)** — `mlLeadReady = mlConfidence >= ML_PRIMARY_MIN_CONFIDENCE (58)`.
  ML decides direction. Each agreeing validator (Claude, Stat, WM) adds `+ML_SIGNAL_BOOST (6%)`.
  ML wins even when Claude+Stat both disagree.
  
- **PATH B (Claude primary)** — ML not ready. Claude leads. If Stat available and disagrees → SKIP
  (no tiebreaker). WM adds `+CONFIDENCE_BOOST_PER_SIGNAL (8%)`.

- **PATH C (Stat primary)** — no ML, no Claude. Stat leads at statConfidence or `BASE_CONFIDENCE_HALF_PAIR (60%)`.
  WM adds `+CONFIDENCE_BOOST_PER_SIGNAL`.

**Why:** ML has been training since day 1 and is the most data-rich signal. Previously it was
only a booster on top of Stat+Claude, so whenever Claude said the opposite direction, ML was
completely ignored.

## Regime filter

`loadRegimeCache` in `kalshi-bot.ts`: queries last N settled bets per symbol (same lookback as
border guard). If ALL closes were above strike → "above"; all below → "below"; else "neutral".

Applied before the border guard:
- against-regime bet → `effectiveConfidence -= REGIME_AGAINST_PENALTY (10)`
- if penalised score < `minConfidence` → SKIP with reason logged
- Loaded once per window alongside border-proximity cache (same refresh trigger).
