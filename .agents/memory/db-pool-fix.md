---
name: DB pool connection fix
description: Root cause and fix for recurring "timeout exceeded when trying to connect" in production
---

## Rule
Replit's managed PostgreSQL kills idle connections at the **PostgreSQL protocol level** regardless of TCP keepAlive. This means `keepAlive: true` alone is not enough.

## Fix applied
- `max: 5` (not 20) — fewer connections = fewer stale ones at once
- `min: 1` — always keep 1 warm
- Short connection-acquire timeout — fail fast so retry/fail-closed behavior can take over
- `startPoolPinger()` — regularly runs `SELECT 1` to keep connections alive at the SQL layer
- `withRetry`: 5 retries, exponential backoff + jitter (not linear 300ms)
- Any database promise started early to overlap unrelated work must attach both fulfillment and rejection handlers immediately. Never leave rejection handling until a much later `await`.

**Why:** With max:20, concurrent bot ticks hitting 20 stale connections simultaneously caused a cascade. Separately, a preflight read rejected while provider warm-up was still running; because its handler was attached only at a later `await`, Node terminated the API for an unhandled rejection.

**How to apply:** Any time DB timeouts return, check pool pressure and polling fan-out first. For intentionally concurrent work, immediately convert each promise into a settled-result shape, then inspect or rethrow that result at the normal ownership boundary.
