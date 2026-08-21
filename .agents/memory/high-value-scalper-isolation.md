---
name: High-value scalper isolation
description: Safety boundary for the late-window Kalshi scalper and its relationship to the regular bot.
---

The high-value scalper must remain an independently owned execution system. It may coexist with a regular position on the same ticker, but it must never share normal-bot triggers, eligibility, reservations, orders, positions, settlement, quiet hours, metrics, or dashboard state.

**Why:** A previous combined implementation introduced duplicate and out-of-range live orders. Isolation makes the scaler’s caps, unknown-order halt, records, and incident response independently auditable, and prevents normal trading behavior from changing as a side effect.

**How to apply:** Put new scalper behavior only in its dedicated modules, tables, routes, and panels. Before changing the feature, fingerprint the protected normal-bot execution files and verify they remain byte-for-byte unchanged. Unknown live order outcomes retain worst-case reserved exposure and must block a circuit-breaker reset until an operator reconciles them with the exchange. Scalper mutations must also deny by default unless an exact configured Clerk operator identity matches; never inherit the regular bot's optional-admin fail-open behavior. Each attempt must size from its atomically reserved immutable risk snapshot; reject any risk/config change again after all pre-submit awaits and after persisting the live order intent. When Freefall Guard is enabled, missing, stale, invalid, or insufficient-lookback price data must block entry. Operator config patches must be strictly typed and allowlisted; never coerce strings or expose internal breaker fields.