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

- **PATH A (ML primary)** — `mlLeadReady = mlConfidence >= ML_PRIMARY_MIN_CONFIDENCE (70)`.
  ML decides direction. Each agreeing validator (Claude, Stat, WM) adds `+ML_SIGNAL_BOOST (6%)`.
  
- **PATH B (Claude primary)** — ML not ready. Claude leads. WM adds `+CONFIDENCE_BOOST_PER_SIGNAL (8%)`.

- **PATH C (Stat primary)** — no ML, no Claude.

### Alignment gate (claude-ML mismatch)

Fires only when `mlConfidence >= ML_ALIGNMENT_GATE_MIN_CONFIDENCE (56)`.

- **ML 50–55% (< 56):** treated as noise. Gate doesn't fire AND no dissent penalty in PATH B.
  stat+claude proceed at full-pair confidence (65). This is the "stat+claude overwhelm weak ML" rule.
- **ML 56–69%:** meaningful dissent → gate fires → SKIP when claude ≠ ML.
- **ML ≥ 70%:** PATH A eligible. Gate still fires if claude disagrees (prevents ML overriding stat+claude 2-vs-1).

### Veto rule (ML confirmation)

When mlLeadReady=true but neither stat nor claude confirms ML's direction → `mlLeadReady=false`.
Falls to PATH B/C rather than letting ML solo-bet.

### Per-coin overrides

`mlPrimaryMinConfidenceOverrides` must be `{}`. Never add per-coin exceptions below 70.
**Why:** different thresholds per coin create inconsistent gate behavior and were the source
of ETH/XRP/SOL betting at 58% which is too low to be reliable.

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
