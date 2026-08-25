---
name: Scalper band-capped IOC limits
description: Durable execution and diagnostics rules for marketable High-Value Scalper IOC orders.
---

Qualify a Scalper candidate against the final authenticated quote, but submit the IOC at the pinned price-band ceiling as the worst acceptable winning-contract cost. YES uses that ceiling directly; NO uses its exact symmetric YES-price complement. Size contracts and check balance against the same worst-case cost, not the more favorable observed quote.

**Why:** Submitting at the exact transient quote caused repeated zero fills when the market moved one cent before Kalshi handled the IOC. The band ceiling makes those in-band moves marketable without relaxing the configured policy or budget. An unknown result can also arise before any network call, so it cannot prove that a locally persisted limit was submitted.

**How to apply:** Keep the final quote band/side checks, IOC-only behavior, bounded submission count, unknown-order hold/reconciliation, and post-fill band breaker unchanged. A proven zero fill may retry immediately only after atomic finalization and a new durable claim; each retry must rerun the full fresh identity, quote, balance, timing, layering, and guard lifecycle with a new intent/client ID. Never retry an unknown or ambiguous result. Show observed-quote versus IOC-cap diagnostics only for confirmed filled or zero-fill live outcomes; label paper values as simulations.