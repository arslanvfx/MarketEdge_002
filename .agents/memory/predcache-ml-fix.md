---
name: predCache must be warm for ML
description: Why ML was null in bot decisions post-restart and how session-scoped snap tracking fixes the cold-start delay
---

## The Rule
The prediction tracker snap loop must populate `predCache` immediately after each `analyzeCoin()` call, AND use a **session-scoped Set** (`snappedThisSession`) rather than DB records to determine whether a snap has already run for the current window.

**Why:** Two layers to the problem:
1. `getCachedPrediction(sym)` (used by ML inference in `kalshi-bot-engine.ts`) reads from `predCache`. That cache was only populated by the frontend endpoint `fetchCryptoPredictions()`. After a restart with no browser tab open, `predCache` is empty → `mlAbove: null` on all bot decisions.
2. Even after adding `predCache.set()` to the snap loop, the DB-based `alreadySnapped = records.some(r => r.targetTime === targetISO)` found pre-restart DB records for the current window → skipped the snap → predCache stayed cold until the next window's 90s `snapFallback` fired (~8-10 minutes of ML=null).

**How to apply:**
- Use `snappedThisSession.has(snapKey)` (module-level `Set<string>`, cleared on server restart) instead of DB record check for `alreadySnapped`.
- Add `snappedThisSession.add(snapKey)` immediately after `predCache.set()` in the window-open snap block.
- On restart: `snappedThisSession` is empty → `alreadySnapped = false` → snap runs on first tick (~30s) → predCache warm by minute 3 instead of minute 10+.
- DB records from prior session don't interfere; `onConflictDoNothing` handles any duplicate writes.

## Architecture
- `predCache`: `Map<string, CacheEntry<CoinPrediction>>` in `crypto-tracker.ts`
- `getCachedPrediction(sym)`: returns `predCache.get(sym)?.value ?? null` (no TTL — stale is fine for ML)
- `snappedThisSession`: `Set<string>` keyed by `${sym}:${targetISO}`, lives at module level
- Fix location: `crypto-tracker.ts` — `alreadySnapped` check (around line 570) + `predCache.set()` line (around line 675)

## Verified
After the fix: `mlAbove: true, mlConfidence: 54` available for HYPE at minute 3 of the 18:30 window
(server restarted at minute 2). Before: all coins showed `mlAbove: null` until minute 10+.
