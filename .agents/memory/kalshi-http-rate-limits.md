---
name: Kalshi HTTP rate-limit control
description: Durable policy for avoiding Kalshi public-market and orderbook 429 retry storms.
---

Kalshi HTTP reads must share in-flight work and a paced request lane. A 429 is an origin-wide signal, not a per-symbol failure, so all nonessential Kalshi HTTP reads must honor the same cooldown. When no Retry-After header is present, use a substantial fallback cooldown rather than waking every symbol together after a few seconds.

**Why:** Multiple independent bot pipelines request the same target windows, and a short per-symbol cooldown caused synchronized retries that repeatedly renewed the upstream throttle.

**How to apply:** Preserve ticker/window-safe cached targets during cooldown, keep exact live prices on the authenticated WebSocket path, never add automatic immediate retries, and ensure queued HTTP reads cancel when another request activates the cooldown.