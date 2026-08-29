---
name: FastLane Conviction mode
description: Durable strategy and execution boundaries for the isolated price-only FastLane mode.
---

FastLane is a separate decision mode. A fresh current-window YES or NO ask inside the configured conviction floor/cap is its sole strategy authorization; it must not inherit model, confidence, stability, trajectory, proximity, freefall, or authenticated-book gates.

**Why:** The mode exists to remove pre-entry processing latency without changing or weakening the established Conviction mode. Kalshi order submission remains authenticated even though a separate authenticated order-book read is intentionally absent.

**How to apply:** Submit IOC at the configured far edge, size and reserve funds from that worst-case edge cost, preserve exact DST-aware ticker/strike identity, duplicate/open-position checks, durable intent/funding ownership, and full reconciliation. Honor the configured per-window entry wait without an early-price bypass. Do not apply a cross-symbol bets-per-window count cap: take every eligible market, constrained only by per-symbol ownership and monetary safety limits. Only confirmed zero fills may retry, no sooner than five seconds and no more than ten submissions per symbol/window. Keep one-second market polling isolated per symbol and clear in-flight ownership on poller restart.