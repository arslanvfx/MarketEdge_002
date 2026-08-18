---
name: Conviction entry latency fix
description: Three-part optimization to reduce time-to-order from zone detection to IOC/FOK submission in conviction mode.
---

# Conviction entry latency optimizations

## Problem
Conviction poller detects zone entry every 1s but the 5-second scheduler loop was the only thing that could dispatch a tick — up to 4.9s gap. Fast-moving markets exit the zone before the first order attempt.

## Fix 1 — Poller-triggered dispatch (kalshi-bot-state.ts + kalshi-bot-loop.ts + kalshi-conviction-poller.ts)

A `convictionZoneEntryCallback` is registered at module load time in `kalshi-bot-loop.ts`. When the poller confirms zone entry (and no active abort cooldown), it calls `callConvictionZoneEntry(sym)` which fires `runBotTickForCoin` immediately.

**Guards in the callback (kalshi-bot-loop.ts):**
- `S.config.enabled && !S.paused && S.dbDegradedSince === null`
- `S.config.decisionMode === "conviction"`
- `!convictionFiredThisWindow.has(sym:wk)` (already bet this window)
- `!openPositions.has(sym)` (open position exists)
- Kalshi data must be non-null

**Guards in the poller dispatch section (kalshi-conviction-poller.ts):**
- `!cooldownActive` — respect the abort cooldown; don't dispatch every 1s when in cooldown
- `S.config.enabled && !S.paused`
- Log "dispatching tick immediately" is INSIDE the dispatch block (not outside — prevents spam when bot is paused)

**Important:** `convictionFiredThisWindow.add()` runs synchronously at the top of `runBotTickForCoin` (before first await) so concurrent dispatches (poller vs 5s loop) can't both pass the guard and double-bet. Proximity blocks delete the entry (no cooldown) so the bot retries on the next poller cycle.

## Fix 2 — Pre-warmed orderbook cache (kalshi-bot-state.ts + kalshi-conviction-poller.ts + kalshi-bot-tick.ts)

Before calling `callConvictionZoneEntry`, the poller pre-fetches the authenticated orderbook and stores it in `convictionObCache` (Map, keyed by sym). The tick reads this cache before its own `fetchOrderbookPrices` call — on a hit, it skips the 0.5–2s Kalshi API round-trip.

**Cache state object (`ConvictionObSnapshot`):** `{ yesAsk, yesBid, fetchedAt, ticker }`

**Cache TTL:** `CONVICTION_OB_CACHE_TTL_MS = 1500` ms. Stale entries or ticker mismatches cause the tick to fall back to a fresh fetch.

**Never cache null (timeout/error):** tick treats null as "retry later"; a cached failure would propagate the error.

**Cleared:** at window transition (alongside `convictionAbortCooldown`).

## Fix 3 — Differentiated abort cooldown (kalshi-bot-state.ts + kalshi-bot-loop.ts + kalshi-bot-tick.ts)

`convictionAbortCooldownMs` Map stores per-`sym:windowKey` cooldown durations. Two values:
- `CONVICTION_BOUNDARY_MISS_COOLDOWN_MS = 2000` — "price past cap" and "empty book poller out of zone" aborts; price may oscillate back quickly
- `CONVICTION_ABORT_COOLDOWN_MS = 5000` (global default) — direction reversals, cross-check aborts

The loop reads `convictionAbortCooldownMs.get(key) ?? CONVICTION_ABORT_COOLDOWN_MS` instead of always using the global 5s.

**Why:** A price that briefly exceeds the cap by 1–2¢ often pulls back within 2s; using a 5s cooldown loses re-entry opportunities.

## Abort-cooldown semantics in the poller

The poller checks whether the cooldown is CURRENTLY ACTIVE (not just present — keys linger after expiry):
```ts
const abortedAt = convictionAbortCooldown.get(cooldownKey);
const storedCooldownMs = convictionAbortCooldownMs.get(cooldownKey) ?? CONVICTION_ABORT_COOLDOWN_MS;
const cooldownActive = abortedAt != null && Date.now() - abortedAt < storedCooldownMs;
```
- Always clears the record on zone re-entry (for the 5s loop to pick up).
- Only dispatches immediately when `!cooldownActive`.
- After an abort+cooldown, the loop (5s cycle) handles the retry; the poller dispatches again only on the next fresh zone entry after the cooldown expires.

**Why:** Dispatching every 1s during an active cooldown would hammer the Kalshi OB API and defeat the rate-limiting intent.

## Zone-mismatch regression (2026-08) — poller MUST use the two-arg zone form

The poller originally derived its zone with the legacy single-arg `deriveConvictionZone(kalshiLockPrice)` (target−2¢..target+3¢ formula), while tick/loop/engine use the two-arg `deriveConvictionZone(kalshiLockPrice ?? 0.82, kalshiLockPriceCap ?? 0.91)` (verbatim floor/cap). The mismatch was harmless when the poller only cleared cooldowns, but once poller-triggered dispatch landed it dispatched ticks for prices OUTSIDE the real zone: every dispatch aborted, transiently set `convictionFiredThisWindow` (starving the 5 s loop of genuine entries), and the poller cleared the abort cooldown ~1 s later — zero bets in dev AND prod.

**Rules:**
- ANY zone derivation anywhere (poller, tick, loop, engine, post-fill check) must use the identical two-arg form with the identical `?? 0.82 / ?? 0.91` fallbacks. The single-arg overload exists only for legacy unit tests.
- The dispatch callback in `kalshi-bot-loop.ts` re-derives the zone independently and suppresses dispatch (warn log "poller zone disagrees with configured zone") when neither the passed `yesAsk` nor `noAsk` is in the real zone — belt-and-suspenders so future poller drift cannot recreate the loop. Callback signature is `(sym, yesAsk, noAsk)`.
- Verification signal: poller log `lockPrice/lockPriceCap` must match the tick's `window [XX–YY%]` diagnostics exactly.
