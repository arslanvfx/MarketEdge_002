---
name: Contrarian Pyth excursion cadence
description: Durable safety rules for using Pyth commodity updates in fast Contrarian reversal detection.
---

Contrarian commodity movement evidence must come from Kalshi's authenticated underlying-value WebSocket lane and distinct upstream publication timestamps. Repeated local reads of one oracle publication are not independent movement samples.

**Why:** Direct Hermes access can require a separate credential that the trading runtime does not own, while Kalshi exposes the settlement-aligned Pyth values through its existing authenticated connection. Pyth publications can arrive around five seconds apart, so trusting local receipt cadence can make one stale publication look like a moving series.

**How to apply:** Use `source_ts_ms`, not WebSocket sequence or receipt time, as publication identity. Keep strict freshness and cadence checks, fail closed on disconnect/malformed evidence, and never substitute cached contract quotes or local poll cadence.