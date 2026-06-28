---
name: Kalshi route cache — negative result caching
description: Why fetchKalshiTargetRoute must not cache available:false responses, and what happens if it does.
---

## Rule
Do NOT store `{ available: false }` results in `kalshiRouteCache` (routes/crypto.ts).  
Only cache successful `{ available: true }` entries.

## Why
Kalshi publishes the new 15-minute window's market 10–30 seconds *after* the boundary fires.  
During that gap the API returns an empty markets list → `available: false`.  
If that negative result is cached with `fetchedAt: Date.now()` and `KALSHI_TARGET_TTL = 15 s`:
- Every frontend poll for the next 15 s gets `available: false` from cache.
- `kalshiAvailable = false` hides the entire Kalshi hub (green-bordered card) including Quarter-Hour Forecasts.
- Users see the section vanish and need a page refresh (or to wait >15 s) to get it back.

## How to apply
In `fetchKalshiTargetRoute`, the `if (!found)` branch must return without writing to the cache:
```typescript
if (!found) {
  return { available: false, targetPrice: null };
  // No kalshiRouteCache.set() — let next request retry Kalshi immediately
}
```
The `if (!resp.ok)` path (line 317) should also not cache for the same reason.
