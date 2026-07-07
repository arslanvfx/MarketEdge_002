---
name: Pipeline fresh-target sequencing
description: Pipeline MUST wait for confirmed new-window Kalshi target before running any analysis; stale target causes contradictory model signals
---

## Rule
`_runPipeline` Step 1 calls `waitForFreshKalshiTarget(sym, windowKey, windowCloseMs, 90_000)` which polls `fetchKalshiTarget(sym, new Date(windowCloseMs))` every 5s. Only when Kalshi returns a market with `close_time` within 8min of `windowCloseMs` does the pipeline proceed to stat → Claude → ML.

**Why:** Kalshi takes 10-30s to publish the new window's market after the 15-min boundary. The cache at `getKalshiCachedData()` holds the OLD window's strike immediately after transition. Running Claude and ML against the stale strike produces contradictory signals (e.g. SOL: Claude↑58% vs ML↓90% because they're referencing different effective targets).

**How to apply:**
- Re-checks (`isRecheck=true`) skip the wait — the market is already confirmed mid-window.
- `fetchKalshiTarget(sym, targetTime)` bypasses the in-memory cache when `targetTime` is provided and always makes a live API call. On success it writes the fresh market data to `kalshiTargetCache`.
- Pipeline phase map (`pipelinePhaseMap`) tracks `waiting-target | fetching-data | claude-analyzing | ml-analyzing` and is exposed via `getInFlightDetails()` → API → UI status labels.
- Claude uses extended thinking: `thinking: { type: "enabled", budget_tokens: 8000 }`, `max_tokens: 12000`. Parse only `type === "text"` blocks for JSON.
