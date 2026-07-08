---
name: Pipeline gate removal
description: The bot tick's pipeline readiness gate was a redundant blocker; removed so bot reads directly from predictor caches.
---

## The rule
The bot tick must NOT gate on `getPipelineResult(sym, windowKey)`. The pipeline gate was removed entirely. The bot reads Kalshi target from `getKalshiCachedData` and signal directions from `getLatestCoinSignals` — both populated by the predictor's continuous tick, which is the same source the Predictor page uses.

**Why:** The bot's own pipeline uses `fetchKalshiTarget(sym, windowCloseDate)` with a strict `close_time` validation (market must be within 8 minutes of the window close). Kalshi sometimes publishes new-window markets 4-8 minutes late. When the 90-second wait times out, the pipeline sets no result. Every subsequent re-check reads null from cache and aborts immediately. The entire window is lost.

Meanwhile, the predictor page uses `fetchKalshiTarget(sym)` WITHOUT targetTime — it simply grabs the first currently-open market, which is always the new window's market (old window's markets drop from the open list when they expire). This reliably works.

The pipeline gate was purely redundant: the bot tick already had `getKalshiCachedData` (for kalshiTarget) and `getLatestCoinSignals` (for signal directions). The pipeline added nothing for entry evaluation.

**How to apply:** In `kalshi-bot-tick.ts`, do NOT add any gate on `getPipelineResult`. The correct gate order is:
1. `getKalshiCachedData(sym)` — if ticker/value/yesPrice null, the tick already returns early upstream
2. `triggerWindowPipeline` — idempotent fire-and-forget (for stability analysis + callback)
3. `getLatestCoinSignals` — hard gate: wait for stat+Claude+ML all non-null

The pipeline still runs (for `trendStability` via `windowStabilityCache`, and for `_firePipelineEntryForCoin` callback). But it is NOT a hard blocker for new entries.

## Evidence
Production server (pid=19) showed `[pipeline] no Kalshi target — aborting` for ALL 7 coins throughout the entire 08:30 window. The pipeline's 90s wait expired before Kalshi published markets. The bot tick never ran because the pipeline gate returned early. The predictor page had all three signals running fine the whole time.

On fresh server restart at 08:38 (8 min into window), `fetchKalshiTarget` (no targetTime, used by prefetch) found all markets immediately. The pipeline's targetTime-validated fetch also succeeded at attempt=1 because by 08:38 markets were published.
