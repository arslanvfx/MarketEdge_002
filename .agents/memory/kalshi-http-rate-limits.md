---
name: Kalshi HTTP rate-limit control
description: Durable policy for avoiding Kalshi public-market and orderbook 429 retry storms.
---

Kalshi HTTP reads must share in-flight work and a bounded paced request lane. A 429 is an origin-wide signal, not a per-symbol failure, so all nonessential Kalshi HTTP reads must honor the same cooldown. When no Retry-After header is present, use a substantial fallback cooldown rather than waking every symbol together after a few seconds.

**Why:** Multiple independent bot pipelines request the same target windows. A short per-symbol cooldown caused synchronized retries, while an unbounded paced lane retained delayed async call chains until the API consumed gigabytes of memory.

**How to apply:** Preserve ticker/window-safe cached targets during cooldown, keep exact live prices on the authenticated WebSocket path, never restore an all-market forced REST loop for live quotes, cap queued delay/work, drain non-success bodies, drop excess best-effort refreshes, and cancel queued reads when another request activates the cooldown.