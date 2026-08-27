---
name: Scalper Fast Smart Exit monitoring
description: Non-obvious identity, scheduling, and mode-isolation rules for the dedicated High-Value Scalper exit monitor.
---

The dedicated Fast Smart Exit must resolve a Scalper symbol through the configured market product before fetching spot data; display symbols such as BTC are not valid Coinbase product IDs. Its Kalshi identity must be tied to the position's exact ticker/window, refreshing that target only when the shared cache points at a different market.

Only unexpired positions matching the configured exit mode may be evaluated. Active positions run concurrently; never process the entire unsettled ledger oldest-first because expired rows and rate-limited market lookups can starve the current position.

**Why:** Production showed many confirmed Scalper fills but zero dedicated exit evaluations. Spot requests used display symbols instead of products, and the monitor iterated every historical unsettled row sequentially before reaching current exposure. Paper exit also lacked a paper-position filter.

**How to apply:** Keep product identity, exact ticker/window identity, active-window filtering, mode filtering, and concurrent active evaluation at the monitor boundary. Historical reconciliation and settlement may continue separately, but must not occupy the hot monitoring path.