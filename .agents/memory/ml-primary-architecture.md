---
name: ML-primary decision architecture
description: New signal priority order and the root cause of the ML null bug that caused ML to be skipped every bet.
---

## ML null root cause (confirmed, fixed)

**Symptom:** `mlAbove: null` in every bet record even for fully-trained coins (74–103 windows).

**Root cause — async cache race:**
`_runBotTick` is async with multiple `await` points before calling `makeBotDecision`.
Between the Phase-3 gate check (`kalshiData.value !== null`) and the `makeBotDecision` call
inside `_runBotTick`, the prediction tracker can call `fetchKalshiTarget` and write
`kalshiTargetCache.set(sym, { value: null })` (window transition or API hiccup). `makeBotDecision`
then re-fetches via `getKalshiCachedData(sym)?.value` → gets null → ML block skipped → `mlAbove: null`.

**Fix:** Added optional `kalshiTarget?: number | null` to `makeBotDecision`. ML block uses it first:
```ts
const mlKalshiTarget = kalshiTarget ?? pred?.kalshiTarget ?? getKalshiCachedData(sym)?.value ?? null;
```
Both callers updated: `_runBotTick` (passes its own `kalshiTarget` param), Phase-3 eval (passes
`kalshiData.value`). Cache fallback kept for tests/other callers.

**Why:** Never re-fetch a cache in a sync function when the caller confirmed the value non-null.
Async awaits between check and use create a TOCTOU race on ephemeral caches (TTL=12s).

## Other ML architecture notes

- `captureMLSnapshot` at line ~3248 in `crypto.ts` is OUTSIDE `if (ai)` — runs for ALL
  KALSHI_SERIES coins (BTC ETH SOL XRP HYPE BNB), not just TRAINING_COINS.
- `CoinPrediction.kalshiTarget` is optional (`?`); `predCache` stores raw `analyzeCoin` without
  it — so `pred?.kalshiTarget` is always `undefined` from the bot engine.
- All 8 CRYPTO_COINS get ML state via `getOrCreate()` called during inference; check per-coin
  readiness via the ml-store hydration log at server startup.

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
