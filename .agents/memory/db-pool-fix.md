---
name: DB pool connection fix
description: Root cause and fix for recurring "timeout exceeded when trying to connect" in production
---

## Rule
Replit's managed PostgreSQL kills idle connections at the **PostgreSQL protocol level** regardless of TCP keepAlive. This means `keepAlive: true` alone is not enough.

## Fix applied
- `max: 5` (not 20) — fewer connections = fewer stale ones at once
- `min: 1` — always keep 1 warm
- `connectionTimeoutMillis: 30000` — enough time for pool to recover
- `startPoolPinger()` — runs `SELECT 1` every 20s to keep connections alive at the SQL layer
- `withRetry`: 5 retries, exponential backoff + jitter (not linear 300ms)

**Why:** With max:20, concurrent bot ticks hitting 20 stale connections simultaneously caused a cascade — all reconnect at once, overwhelm auth handshake, every retry also times out. Smaller pool + SQL-level keepalive prevents this.

**How to apply:** Any time DB timeouts return in production, check pool size first. If `max > 5`, reduce. Ensure `startPoolPinger()` is called at server startup in `artifacts/api-server/src/index.ts`.
