---
name: Window-open pre-fetch pipeline
description: Checks-and-balances orchestrator that warms all signals before the T+120s entry buffer clears
---

## Rule
When a new 15-min window is detected, `runWindowOpenPrefetch(windowKey)` runs a two-step chain:

**Step 1** — All Kalshi targets fetched in parallel (`Promise.allSettled`). A coin is "confirmed" only when `getKalshiCachedData` returns non-null `value` AND `yesPrice`. Failures are logged as "deferred" and left for the per-tick fallback.

**Step 2** — Stability analysis fired **only** for coins that passed Step 1. Uses `stabilityFiredForCoins` guard (same Set as the bot loop) to prevent double-dispatch. On error or null result, coin is removed from the guard so the bot-loop fallback retries.

## Trigger points (two independent paths)
- **Tracker** (`crypto.ts`): `startPredictionTracker` now accepts `onNewWindow?: (wk: string) => void`. The tracker detects window transitions via `lastTrackerWindowKey` each tick and calls it — fires up to 30s earlier than the bot loop due to phase offset.
- **Bot loop** (`kalshi-bot.ts`): when `newWindowKey !== lastStabilityWindowKey`, void-launches `runWindowOpenPrefetch`. Redundant but guarantees the chain fires even if the tracker callback was missed.

Both paths use the same `stabilityFiredForCoins` guard — only the first arrival dispatches.

## Bot-loop fallback
After `runWindowOpenPrefetch` runs, the inline stability dispatch block remains as a per-tick fallback. It catches coins whose Kalshi markets published late (10–30s after boundary), which `runWindowOpenPrefetch` deferred.

## No circular dependency
`kalshi-bot.ts` imports from `crypto.ts`. The `onNewWindow` callback is threaded via `index.ts` only — `crypto.ts` never imports from `kalshi-bot.ts`.

**Why:** Without this, stability analysis was never dispatched until the bot loop detected the new window (up to 30s late) AND Kalshi data was warm — meaning bets could fire 30–60s after T+120s with `trendStability="pending"` or stale signals.
