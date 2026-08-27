---
name: Scalper Fast Smart Exit monitoring
description: Non-obvious identity, scheduling, and mode-isolation rules for the dedicated High-Value Scalper exit monitor.
---

The dedicated Fast Smart Exit must resolve a Scalper symbol through the configured market product before fetching spot data; display symbols such as BTC are not valid Coinbase product IDs. Its Kalshi identity must be tied to the position's exact ticker/window, refreshing that target only when the shared cache points at a different market.

Only unexpired positions matching the configured exit mode may be evaluated. Active positions run concurrently; never process the entire unsettled ledger oldest-first because expired rows and rate-limited market lookups can starve the current position.

The hot lane must remain sub-second and bounded: run evaluations independently from discovery and maintenance, coalesce each order to one in-flight pass, and enforce evidence deadlines by aborting the underlying provider request. Deadline eviction must be generation-safe so an old timeout or completion cannot remove a newer replacement request. When concurrency is exhausted, record an explicit blocked/SLA state for every skipped order, not only aggregate overload telemetry.

Source continuity must follow authoritative provider identity rather than local receipt time. Coinbase samples use provider timestamps plus trade identity. Pyth may publish distinct payloads within the same whole second, so accept equal publish times only when the authoritative price/confidence fingerprint changes; reject exact duplicate fingerprints and regressing timestamps.

**Why:** Production showed many confirmed Scalper fills but zero dedicated exit evaluations. Spot requests used display symbols instead of products, and the monitor iterated every historical unsettled row sequentially before reaching current exposure. During hardening, non-aborted deadline failures could pin coalesced requests across the whole short position lifetime, aggregate-only overload hid which positions missed their SLA, and Pyth's whole-second timestamp alone could not distinguish genuine updates from repeated payloads.

**How to apply:** Keep product identity, exact ticker/window identity, active-window filtering, mode filtering, concurrent active evaluation, abortable generation-safe coalescing, per-order overload state, and provider-native source continuity at the monitor boundary. Historical reconciliation, settlement, and deferred telemetry writes belong on a separate maintenance lane and must not occupy the hot path.