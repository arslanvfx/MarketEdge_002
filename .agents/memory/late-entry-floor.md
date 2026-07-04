---
name: Late-entry hard floor
description: Why there are two time-remaining guards and how they interact — stale tick-start guard vs fresh order-time guard
---

# Late-entry hard floor — two-layer design

## The problem (caused a real-money loss)
`minRemainingMinutes` was checked once at the TOP of `_runBotTick` using
`winCtx.secondsElapsed` — a value captured when the tick began.  Between that
check and `placeOrderWithRetry`, 10–30+ seconds of async work runs: signal
reads, decision engine, balance API call, FOK retry loop (up to ~2.3s added
by the Phase-1/Phase-2 retry logic).

A tick that started with "2m30s remaining" can place a live order with under
a minute left — or even after the window closes.

## The fix — two-layer guard

**Layer 1 (soft, tick-start):** `minRemainingMinutes` early-exit near the top
of the tick.  Default now 3 (was 0).  If the configurable value is lower than
3 the hard floor still protects.  Purpose: skip the entire tick fast, avoiding
all the signal fetches and async work when time is running out.

**Layer 2 (hard, order-time):** `HARD_LATE_ENTRY_FLOOR_S = 3 * 60` checked with
a fresh `Date.now()` computation immediately before `placeOrderWithRetry`.  This
cannot be configured away.  Any tick latency — regardless of cause — that pushes
the actual placement past the 3-minute mark is caught here.

**Why:** `winCtx.secondsElapsed` is a snapshot from the start of the tick.  It
goes stale the instant async work begins.  The hard floor uses `Date.now()` so
it is always accurate at the moment of order placement.

## Production config note
The prod DB has `minRemainingMinutes: 2` stored (overrides the new default of 3).
The hard floor guarantees no order executes with <3 min remaining regardless.
Recommend updating the UI config to 3 or higher for defense-in-depth.
