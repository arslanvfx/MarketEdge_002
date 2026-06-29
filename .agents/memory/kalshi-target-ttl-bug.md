---
name: KALSHI_TARGET_TTL deletion bug
description: How a deleted constant caused production 500s only after the first request, and why dev was silently unaffected.
---

## The rule
When inserting a new constant/variable near an existing one via old_string/new_string edit, verify the edit does NOT swallow adjacent constant definitions. Always grep for every identifier referenced in the block being edited before and after.

## What happened
`const KALSHI_TARGET_TTL = 15_000` was defined at line 359 of `routes/crypto.ts`.
An edit that inserted `mlKalshiCache` used an `old_string` that started with `kalshiRouteCache` and ended with `async function fetchKalshiTargetRoute` — which spanned and deleted the `KALSHI_TARGET_TTL` line.

## Why it was silent in dev
The first `curl` hit the endpoint when `kalshiRouteCache` was empty → `cached = undefined` → the `&&` short-circuited before JS ever evaluated `KALSHI_TARGET_TTL`. The ReferenceError only fires on the second-and-beyond requests (when the cache has an entry and `cached` is truthy). Dev testing with a single hit never triggered it.

## Why it only showed in production
Production served real traffic. Request 1 succeeded (empty cache → Kalshi API call → cache populated → 200 OK, ~33ms). Requests 2+ found `cached` truthy → evaluated `KALSHI_TARGET_TTL` → `ReferenceError` → caught by route's try/catch → 500, 1-4ms.

**Why:** JS `ReferenceError` for an undeclared variable only throws when that expression is actually evaluated. Short-circuit `&&` hides it on the first (cache-empty) call.

**How to apply:** After any edit that touches a block of top-level constants, grep for every symbol used in the affected function to confirm all definitions still exist. The pattern `const cached = ...; if (cached && ... < SOME_CONST)` is especially risky because single-hit dev tests never exercise the `SOME_CONST` branch.
