---
name: Conviction concurrent dispatch race condition
description: Root cause and fix for multiple simultaneous Kalshi orders placed in the same window by the conviction poller.
---

# Conviction concurrent-dispatch race condition

## The rule
`convictionDispatchInFlight` must be set **synchronously** (before any `await`) in `pollOnce()` to prevent concurrent OB pre-warm calls from each dispatching independently.

**Why:** `pollOnce()` runs every 1 second. Each tick checks `convictionFiredThisWindow` (empty until a bet is recorded) then calls `await fetchOrderbookPrices()` for OB pre-warm. This `await` yields the event loop. The next 1-second tick enters the same guard (bet still not placed), queues its own OB pre-warm, and so on. When the OB cache is warm, all queued dispatches unblock simultaneously — each one calls `callConvictionZoneEntry` independently. This caused 17 simultaneous Kalshi IOC orders for WTI in a single window (6:43 PM ET). Fills were orphaned because the server restarted between the fills and `persistBetRecord`.

**How to apply:**
1. In `kalshi-conviction-poller.ts` `pollOnce()`: call `convictionDispatchInFlight.add(inFlightKey)` BEFORE the first `await` inside the dispatch block; bail immediately with `return` if the key is already present.
2. Clear the lock with `convictionDispatchInFlight.delete(inFlightKey)` AFTER `callConvictionZoneEntry` fires (not before), so abort-cooldown retries can re-enter.
3. In `kalshi-bot-loop.ts` window-transition cleanup: call `convictionDispatchInFlight.clear()` alongside `convictionFiredThisWindow.clear()`.
4. `convictionFiredThisWindow` (set inside `_runBotTick` after a bet is recorded) is the durable guard; `convictionDispatchInFlight` only covers the brief window between OB pre-warm start and dispatch completion.

## Key files
- `artifacts/api-server/src/lib/kalshi-bot-state.ts` — exports `convictionDispatchInFlight = new Set<string>()`
- `artifacts/api-server/src/lib/kalshi-conviction-poller.ts` — the synchronous lock acquisition in `pollOnce()`
- `artifacts/api-server/src/lib/kalshi-bot-loop.ts` — window-transition `convictionDispatchInFlight.clear()`
- `artifacts/api-server/src/lib/kalshi-bot-tick.ts` — added `.catch(logger.error(..., CRITICAL))` on `persistBetRecord` so orphaned fills are never silent again
