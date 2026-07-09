---
name: Pipeline lock released on Kalshi-null
description: pipelineEntryFiredThisWindow must be deleted when Kalshi data is missing at pipeline trigger time, or Phase-3 is permanently blocked.
---

**Rule:** In `_firePipelineEntryForCoin`, check `kalshiData?.ticker`, `kalshiData?.value`, and `kalshiData?.yesPrice` BEFORE logging "evaluating entry". If any are null/missing, call `pipelineEntryFiredThisWindow.delete(`${sym}:${windowKey}`)` and return immediately.

**Why:** The pipeline completion callback adds the coin to `pipelineEntryFiredThisWindow` at line 208 — synchronously, before the async `_firePipelineEntryForCoin` runs. Kalshi markets publish 4-8 min after window-open. If the pipeline fires before the Kalshi market is cached, `runBotTickForCoin` silently returns at the `!kalshiTicker || kalshiTarget === null` guard with NO log. The coin is permanently locked out of Phase-3 for the rest of the window. No SKIP or BET is ever emitted — this was the root cause of production betting stoppage.

**How to apply:** Any time `_firePipelineEntryForCoin` gains a new early-return path (bot disabled, window expired, position open, etc.), ask: "is `pipelineEntryFiredThisWindow` already set?" If yes and the return is due to transient/recoverable conditions (missing market data), delete the key first. Permanent conditions (bot disabled, window expired) should NOT release the lock.
