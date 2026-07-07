---
name: predCache override YES bias
description: applyStatPredCacheOverride used live price vs target (not model forecast) — caused all-YES bias; fix guards on openingAbove !== null
---

## Rule
`applyStatPredCacheOverride` must return `openingAbove` immediately when `openingAbove !== null`.
The predCache stores the **live price** (from `analyzeCoin`), not a predictive model output.
`livePrice >= kalshiTarget` is a current-position check, not a forecast.

## Why
In bullish markets, live price tends to be above the Kalshi target for most of the window.
Before the fix, the predCache override fired for the **entire** window (predCache always newer than T+1min snap),
replacing the stat model's BELOW predictions with "live price above target" = ABOVE.
Result: 100% YES bets even when stat/ML models unanimously predicted BELOW.

Confirmed in DB: 09:00 window snap at T+1min showed ALL coins BELOW; bot bet YES on all
because predCache at T+6min had live price > target → override replaced the real prediction.

## How to apply
- `openingAbove !== null` → return `{ statAbove: openingAbove, isLive: false, flipped: false }` immediately.
- Only use the predCache live-price fallback when `openingAbove === null` (first ~1min of window before snap fires).
- The `flipped` flag is now always `false` from this function — Claude re-checks are driven by the tracker's own divergence logic, not by predCache state.
