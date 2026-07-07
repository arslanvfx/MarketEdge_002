---
name: Bot signal pipeline architecture
description: Sequential per-coin signal pipeline that replaced the stale-signal TTL gate; architecture, timing, and integration points.
---

## Root cause fixed
Tracker refreshed Claude every 5 min; bot gate required freshness within 2 min → guaranteed 3-min stale gap every cycle, causing "live-signal-stale-hard-stop" skips every window.

## New architecture
`kalshi-bot-pipeline.ts` — per-coin sequential pipeline:
1. Kalshi target (from cache, abort if null)
2. Stat signal (`getStatWindowCall` — may be null early in window)
3. Claude — fresh call with rich prompt (explicit window close in UTC + ET, stat direction, last 20 candles, RSI/MACD/BB%B/ER/regime, live price vs strike); 60s timeout
4. ML prediction (`extractMLFeatures` + `getMLPrediction`)

Results stored in `pipelineResults: Map<string, PipelineResult>` keyed by `${sym}:${windowKey}`.  
Claude verdict written to `liveDirectionCache` so `_makeBotDecisionInner` picks it up via `applyClaudeLiveOverride` with no engine changes.

## Trigger points
- **Primary**: `runWindowOpenPrefetch` fires `triggerWindowPipeline(sym, windowKey)` for each confirmed coin after step 1 (Kalshi target confirmed)
- **Fallback**: `_runBotTick` new-ticker detection fires `triggerWindowPipeline(sym, windowKey)` for coins whose market wasn't published at prefetch time
- Both paths are idempotent — `triggerWindowPipeline` is a no-op if pipeline already complete or in-flight

## Bot tick gate (kalshi-bot-tick.ts)
Replaced `shouldDeferForLiveSignal` (2-min TTL check) with:
```typescript
if (getPipelineResult(sym, windowKey) === null) return; // defer
```
No time-based fallback — prefer missing the window entry over betting with stale signals.

## Re-check for open positions (kalshi-bot-loop.ts)
Every 2.5 min (`PIPELINE_RECHECK_INTERVAL_MS = 150_000`), `runPipelineRecheck(sym, windowKey)` re-runs Claude + stat for each open position.  
Exit triggered if: `signalsAgainstBet > signalsForBet` AND `exitValue / entryCost >= 0.25`.

## Key invariants
- `pipelineResults` keyed by window, not wall-clock time — no TTL races
- Re-check uses separate in-flight key (`${sym}:${windowKey}:recheck`) — doesn't block initial pipeline
- `analyzeCoin` (fresh indicators) requires `stats != null` — guard before call
- `CoinDef` (not `{product, name}`) required by `analyzeCoin` — pass full coin object from CRYPTO_COINS

**Why:** The old 2-min TTL gate always had a gap whenever the 5-min tracker refresh cycle was mid-way. Window-keyed results eliminate all time-based staleness — the pipeline result is either "done for this window" or "not yet done".
