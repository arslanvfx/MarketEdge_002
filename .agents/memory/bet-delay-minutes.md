---
name: betDelayMinutes — delayed entry with fresh re-analysis
description: How betDelayMinutes works and how it differs from minNoEntryMinutes
---

**Rule:** `betDelayMinutes` (BotConfig, optional, default 0) delays ALL entry attempts (YES + NO) until N minutes after window-open, then fires a fresh `runPipelineRecheck()` before calling `runBotTickForCoin`. This ensures the bot acts on updated Claude + stat signals, not the opening snapshot.

**How it works:**
- `_firePipelineEntryForCoin` computes `remainingMs = betDelayMs - clockElapsedMs`
- If `remainingMs > 0`: schedules `_firePipelineEntryAfterDelay` via setTimeout, returns immediately (pipeline lock stays set so Phase-3 doesn't double-fire)
- If already past delay (signals arrived late): runs `runPipelineRecheck` synchronously then proceeds
- `_firePipelineEntryAfterDelay`: re-checks window validity + open position before running the recheck + tick

**Why:** The opening pipeline fires at ~T+2-3min when Claude completes. Market direction at T+2 often reverses by T+4-6. Waiting N minutes and re-running Claude gives a materially different (and more reliable) signal before committing.

**Contrast with minNoEntryMinutes:** that field only defers NO bets, no re-analysis runs. betDelayMinutes defers everything and re-analyzes.

**How to apply:** When adjusting, coordinate with `maxEntryMinutes` — if betDelayMinutes=5 and maxEntryMinutes=7, there's only a 2-min window to actually place a bet. Keep betDelayMinutes ≤ maxEntryMinutes − 2.
