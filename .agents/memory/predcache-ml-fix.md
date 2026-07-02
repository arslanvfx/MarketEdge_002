---
name: predCache must be warm for ML
description: Why ML was always null in bot decisions and how the tracker snap loop fixes it permanently
---

## The Rule
The prediction tracker snap loop (`startPredictionTracker` in `crypto.ts`) must call `predCache.set(sym, { at: Date.now(), value: analysis })` immediately after each `analyzeCoin()` call.

**Why:** `getCachedPrediction(sym)` (used by the bot's ML inference in `kalshi-bot-engine.ts`) reads from `predCache`. That cache was **only** populated by `fetchCryptoPredictions()`, which is the API endpoint called by the frontend dashboard. If no browser tab is open (production overnight, server restart, inactive session), `predCache` is empty and `getCachedPrediction` returns `null` — silently skipping all ML inference on every bet.

**How to apply:** Any time ML is showing `mlAbove: null` / `mlConfidence: null` in bet records despite models being ready (windows ≥ 30), the first thing to check is whether `predCache` is being populated independently of frontend polling. The tracker snap loop is the right place because it runs every ~15 minutes for all CRYPTO_COINS regardless of user activity.

## Architecture
- `predCache`: `Map<string, CacheEntry<CoinPrediction>>` in `crypto.ts`
- `getCachedPrediction(sym)`: returns `predCache.get(sym)?.value ?? null` (no TTL check — stale values are fine for ML)
- `fetchCryptoPredictions()`: populates predCache via frontend API calls — unreliable for bot use
- Fix location: `crypto.ts` in the `startPredictionTracker` snap block, right after the `analyzeCoin()` call (~line 3063)
