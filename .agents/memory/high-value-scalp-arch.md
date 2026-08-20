---
name: High-value scalp architecture (post-redesign)
description: Scalp detection moved from bot-loop-tick stale-cache reads to the conviction poller's 1-second fresh-price cycle. runHighValueScalpForCoin accepts prices directly; syncConvictionPoller starts when highValueScalpEnabled.
---

# High-value scalp — poller-driven architecture

## The rule
High-value scalp detection MUST run inside the conviction poller's `pollOnce()` using the just-fetched fresh prices, NOT as a separate scan in the bot loop tick reading a cached price.

## Why
The original `runHighValueScalpScan()` in the bot loop tick read from `getConvictionLivePrice()`, which could be stale (1.5s TTL but poller might stop refreshing a coin if it was no longer in conviction zone). Both the initial and final eligibility checks used the same stale map entry. An IOC order placed at limitPrice=91¢ could fill at 70¢ (the real market price, price-improved downward) while both checks had passed on a stale 91¢ reading.

## Architecture

- **`kalshi-conviction-poller.ts` → `pollOnce()`**: After updating `convictionPriceMap` with the fresh Kalshi quote, immediately checks scalp band (independent of `convictionFiredThisWindow`). When yesInBand XOR noInBand, calls `runHighValueScalpForCoin(sym, freshPrices, nowMs)` as fire-and-forget.

- **`kalshi-high-value-scalper.ts` → `runHighValueScalpForCoin(sym, prices, now?)`**: Exported function, takes fresh prices directly. No import from `kalshi-conviction-poller` (no circular dep). Initial check uses `prices` arg; final re-check reads `kalshiTargetCache` directly (just updated by same poll cycle). Out-of-band fills: attempt immediate IOC sell close (live mode), remove from firedKey, don't persist.

- **`syncConvictionPoller()`**: Starts when `decisionMode === "conviction" || highValueScalpEnabled`. This ensures the 1s poller runs whenever scalp is enabled, even in non-conviction modes.

- **`kalshi-bot-loop.ts`**: `runHighValueScalpScan()` call removed (replaced with comment). The exported function is now a no-op kept for compat.

## How to apply
- Never add a separate poller or tick-scan for scalp detection — use the existing conviction poller
- `runHighValueScalpForCoin` is the entry point; it handles all guards (fired-set, paused, timing, eligibility, caps, final re-check, order)
- The `highValueScalpFiredThisWindow` Set is the dedup guard; it's set synchronously before the first await to prevent concurrent dispatches
- `syncConvictionPoller()` must be called after any config change to `highValueScalpEnabled` (it already is via `kalshi-bot-db.ts` updateBotConfig path)
