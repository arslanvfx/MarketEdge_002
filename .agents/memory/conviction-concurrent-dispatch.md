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

## Conviction bot "order placement failed" retry — the REAL cause of 20+ SILVER bets
`catch (err)` at the end of the IOC/FOK placement block (kalshi-bot-tick.ts) previously called `releaseConvictionEntryReservation("order placement failed")`, clearing `convictionFiredThisWindow`. Rationale was "retry on transient errors". But we already dispatched an HTTP request to Kalshi before hitting the catch — a network timeout or 429 does NOT mean Kalshi rejected the order. Retrying = doubling position on every retry. With a 1-second poller, 20 retries in 20 seconds = 20 real Kalshi orders.

**Fix (applied):** Removed `releaseConvictionEntryReservation` from the catch block entirely. Placement errors now block the coin for the rest of the window. The operator must check Kalshi order history to reconcile. Normal entry resumes next window.

**Rule:** Never retry after an order that was already dispatched to the exchange. The outcome is ambiguous. Fail closed.

## Root cause of 20+ duplicate SILVER bets (deeper bug)
The `scalpDispatchInFlight` lock was a correct but INCOMPLETE fix. The real killer was inside `runHighValueScalpForCoin`:
- `highValueScalpFiredThisWindow.add(firedKey)` was set AFTER the `await getCachedKalshiBalance()` call (line ~166), not before it — so the "synchronous before any await" comment in the docstring was wrong
- Lines 221, 229, 258: `highValueScalpFiredThisWindow.delete(firedKey)` was called on EVERY failure (zero fills, thrown error, out-of-band fill) to "allow retry next tick"
- Combined: lock released via `.finally()` + guard deleted on failure = both cleared simultaneously → next 1-second poll re-dispatched a real order
- SILVER was in the scalp band for 20+ seconds with IOC orders failing → 20+ real orders placed → $80 loss

**Correct fix (applied):**
1. `highValueScalpFiredThisWindow.add(firedKey)` moved to the very first line after the `has()` check — BEFORE any await
2. All three `highValueScalpFiredThisWindow.delete(firedKey)` calls REMOVED — failed attempts block the coin for the rest of the window (same as FOK cooldown in conviction bot)
3. No "retry next tick" via poller — if retry is ever needed, it must be an internal retry loop inside the function

**Rule:** Never delete a window-scoped "fired this window" guard to allow external retry. External retry = unbounded re-dispatch for the entire time the condition is met.

## Scalper has the same race — scalpDispatchInFlight
The HIGH-VALUE SCALPER has an identical race in the same `pollOnce()` loop. `runHighValueScalpForCoin` is async; `highValueScalpFiredThisWindow` only sets after the fill. Without a lock, 4 concurrent 1-second polls each placed a 6-contract XRP order (4 × ~$5.35 = $21.37 total at 8:13pm ET).

Fix: `scalpDispatchInFlight = new Set<string>()` in `kalshi-bot-state.ts`. In `pollOnce()`, check/set synchronously before the dispatch, release in `.finally()`. Clear on window transition in `kalshi-bot-loop.ts` alongside `highValueScalpFiredThisWindow`.

**Rule:** Every fire-and-forget async dispatch in the 1-second poller loop MUST have a synchronous in-flight lock. The durable fired-this-window guard is not enough because it only sets after the async order completes.

## Key files
- `artifacts/api-server/src/lib/kalshi-bot-state.ts` — exports `convictionDispatchInFlight = new Set<string>()`
- `artifacts/api-server/src/lib/kalshi-conviction-poller.ts` — the synchronous lock acquisition in `pollOnce()`
- `artifacts/api-server/src/lib/kalshi-bot-loop.ts` — window-transition `convictionDispatchInFlight.clear()`
- `artifacts/api-server/src/lib/kalshi-bot-tick.ts` — added `.catch(logger.error(..., CRITICAL))` on `persistBetRecord` so orphaned fills are never silent again
