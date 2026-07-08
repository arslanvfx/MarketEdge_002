---
name: Pipeline-completion entry trigger
description: Architecture for immediate bet entry when all three models complete — replaces the old 60s time buffer.
---

## Rule
The time-based entry buffer (WINDOW_ENTRY_BUFFER_S / 60s) has been **removed** from both `kalshi-bot-loop.ts` (Phase-3 pre-filter) and `kalshi-bot-tick.ts` (hard block before pipeline gate).

Entry is now triggered exactly once per coin per window by `_firePipelineEntryForCoin()`, which fires the instant the initial pipeline completes for that coin.

## Architecture

### Callback registration (kalshi-bot-pipeline.ts)
`registerPipelineCompleteCallback(fn)` — one callback slot; called by `_runPipeline` after `pipelineResults.set()` when `!isRecheck`.

### Module-level Set (kalshi-bot-loop.ts)
`pipelineEntryFiredThisWindow: Set<string>` — keyed `sym:windowKey`.  Cleared on every window transition alongside `liveDirectionCache`.

### Callback handler (kalshi-bot-loop.ts)
Registered at module load.  Adds the key to the Set (idempotent guard), then calls `_firePipelineEntryForCoin()` as fire-and-forget.

### `_firePipelineEntryForCoin(sym, windowKey)` (kalshi-bot-loop.ts)
Fast precondition checks: bot enabled, not paused, DB healthy, window still current, no open position.  Then calls `runBotTickForCoin()` directly (bypasses Phase-3 pre-filter; all quality gates are inside the tick).

### Phase-3 scheduler skip (kalshi-bot-loop.ts)
After `windowFailedFills` check, before `maxEntryMinutes` check:
```
if (pipelineEntryFiredThisWindow.has(`${sym}:${windowKey}`) && !openPositions.has(sym)) {
  filteredByNewGuards.add(sym);  // exclude from Phase-4
  evalResults.push(... SKIP "pipeline-triggered entry already evaluated this window" ...);
  continue;
}
```
Coins whose Kalshi market was deferred (no pipeline result yet) are NOT in the Set and remain eligible for retry via the scheduler.

**Why:** `filteredByNewGuards.add(sym)` is required — without it, Phase-4 would still call `runBotTickForCoin()` for SKIP coins, causing a double-evaluation.

## What NOT to do
- Do NOT reintroduce a time-based entry buffer for production paths.
- Do NOT call `runBotLoopTick()` from `_firePipelineEntryForCoin` — that evaluates all coins and breaks the per-coin trigger model.
- Do NOT clear `pipelineEntryFiredThisWindow` inside the scheduler tick — only on window transition.

## Deferred coins
Coins where the Kalshi market publishes late (XRP, BNB sometimes take 10+ minutes) complete their pipeline late via the per-tick retry path in `runWindowOpenPrefetch`.  When the pipeline completes, the callback fires and `_firePipelineEntryForCoin` runs.  The Phase-3 scheduler will then see the Set entry and skip re-evaluation.
