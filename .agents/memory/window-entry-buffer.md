---
name: Window entry buffer first-tick blind spot
description: Why WINDOW_ENTRY_BUFFER_S history and safe lower bound after prefetch gate was added
---

## Rule
`WINDOW_ENTRY_BUFFER_S = 60` (1 minute). Do NOT lower below 60s without verifying
`recentKalshiTargets` for the current window is populated before the first bet attempt.

## Why
`recentKalshiTargets` is seeded from DB at startup (historical window strikes) and appended
during the live tick loop as the bot observes each new window's Kalshi target price. At the
original 45-second mark, the current window's Kalshi target may not yet be in the map —
Kalshi can take 30–60s to publish a new window's contract, and the bot must fetch + append it.

The momentum override (`checkMomentumOverride`) reads `recentKalshiTargets`. Without the
current window's strike, the last-3-window trend may appear flat/mixed even when the market
is clearly trending. This caused an ETH NO bet to be placed blind.

The buffer was raised to 120s conservatively. It was later reduced to 60s because
`runWindowOpenPrefetch` (Step 1) now explicitly confirms a non-null Kalshi strike + yes-price
before firing the immediate post-prefetch tick. That hard data-quality gate makes the 120s
blanket wait unnecessary for coins that publish quickly.

## How to apply
- If WINDOW_ENTRY_BUFFER_S must change again, verify that `recentKalshiTargets` for the
  CURRENT window has been populated before bets are allowed. The prefetch gate is the key
  protection; the buffer is a fallback for late-publishing markets.
- The effective betting window is `WINDOW_ENTRY_BUFFER_S → (15*60 - HARD_LATE_ENTRY_FLOOR_S)`,
  currently 60s → 720s = 11 minutes. That is plenty of time for all bet strategies.
- Claude eager-prefetch fires on new-ticker detection (before the warmup ends), so 60s
  still gives Claude well over its typical 5–10s response time.
