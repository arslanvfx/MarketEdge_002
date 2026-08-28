---
name: Bot 1 selectable live gateway
description: Safety boundary for testing authenticated-book execution without replacing Bot 1's proven live path.
---

Bot 1's authenticated-book live execution must remain a separate operator-selectable gateway, with the legacy gateway as the default and immediate rollback path.

**Why:** The user wants to test better live fill behavior without risking the profitable market discovery and decision system or overwriting the established live execution path.

**How to apply:** Both gateways share Bot 1's signals, sizing policy, durable intents, route funding, ledger, reconciliation, quiet hours, risk controls, and exits. The authenticated gateway may only replace final quote/depth validation and IOC limit construction; it must fail closed on stale, changed, mismatched, out-of-zone, or insufficient-depth books.

A marketable IOC limit enforces only the worst acceptable price; it cannot enforce a minimum side cost because Kalshi may price-improve into cheaper resting levels. For a strict entry band, inspect the unfiltered best executable side cost and abort if it is below the floor. Never filter cheaper levels away before deciding whether submission is safe.

The gateway shown as active in the operator UI must come from the server-returned canonical config, not a local unsaved draft. A draft selection must be labeled pending until persistence succeeds.

Authenticated-book entries should be awakened by accepted sequence-valid WebSocket book updates, not by waiting for the public quote poller. The stream is only a trigger: it must enter Bot 1 through the same guarded tick, with shared in-flight coalescing and durable intent as the final duplicate-submit defense.

**Why:** Public one-second polling, request overlap, and rate limits created a multi-second paper-versus-live entry gap even though final book validation itself was effectively instantaneous.

**How to apply:** Require exact current-window ticker and confirmed strike identity, feed the accepted fresh book into the existing live-price gate, retain polling as fallback, and keep cooldown, freefall, funding, Smart Hours, depth, band, and final revalidation checks fail closed. Derive ticker timestamps in New York local time with DST, never a fixed UTC offset.