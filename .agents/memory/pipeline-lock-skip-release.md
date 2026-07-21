---
name: pipeline lock released on SKIP
description: _firePipelineEntryForCoin must release pipelineEntryFiredThisWindow when runBotTickForCoin results in a SKIP (no position opened).
---

## Rule
After `await runBotTickForCoin(...)` in `_firePipelineEntryForCoin`, if `!openPositions.has(sym)`, delete the lock:
```ts
if (!openPositions.has(sym)) {
  pipelineEntryFiredThisWindow.delete(`${sym}:${windowKey}`);
}
```
Also release on catch (error path).

**Why:** The pipeline fires once on model completion and adds the coin to `pipelineEntryFiredThisWindow` before calling the entry function. If the tick results in a SKIP (signal floors not met, ROI too low, etc.), the lock was never released — permanently blocking Phase-3 per-tick retries for the entire window. The bot would see every coin as "already evaluated" and skip all of them until the next window.

**How to apply:** The lock should only persist while a position is actually open. A SKIP means "try again later" — release the lock so Phase-3 retries on every subsequent tick within the window.
