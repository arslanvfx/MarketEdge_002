---
name: Window entry buffer first-tick blind spot
description: Why WINDOW_ENTRY_BUFFER_S is 120s and what breaks if you lower it back to 45s
---

## Rule
`WINDOW_ENTRY_BUFFER_S = 120` (2 minutes). Do NOT lower this back to 45 seconds.

## Why
`recentKalshiTargets` is seeded from DB at startup (historical window strikes) and appended
during the live tick loop as the bot observes each new window's Kalshi target price. At the
45-second mark, the current window's Kalshi target may not yet be in the map — Kalshi can
take 30–60s to publish a new window's contract, and the bot must fetch + append it.

The momentum override (`checkMomentumOverride`) reads `recentKalshiTargets`. Without the
current window's strike, the last-3-window trend may appear flat/mixed even when the market
is clearly trending (e.g. ETH: 1745→1746→1744→1746 looks flat; adding 1752→1760 reveals
a clear uptrend). This caused an ETH NO bet to be placed blind at second 46, then the
override correctly fired on all subsequent ticks (by minute 2) but could not undo the bet.

## How to apply
- If WINDOW_ENTRY_BUFFER_S must change (e.g. for a fast-window strategy), verify that
  `recentKalshiTargets` for the CURRENT window has been populated before bets are allowed.
- The effective betting window is `WINDOW_ENTRY_BUFFER_S → (15*60 - HARD_LATE_ENTRY_FLOOR_S)`,
  currently 120s → 720s = 10 minutes. That is plenty of time for all bet strategies.
- Claude eager-prefetch fires on new-ticker detection (before the warmup ends), so 120s
  gives Claude well over its typical 5–10s response time.
