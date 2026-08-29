---
name: Bot 1 selectable live gateway
description: Safety boundary for testing authenticated-book execution without replacing Bot 1's proven live path.
---

Bot 1's authenticated-book live execution remains operator-selectable for non-conviction modes, with the legacy gateway as their default and rollback path. Live conviction IOC entry always requires the authenticated-book safety boundary regardless of that setting.

**Why:** The user wants selectable execution generally, but a legacy conviction IOC can accept exchange price improvement below the configured floor. Conviction therefore cannot safely bypass unfiltered full-depth validation.

**How to apply:** Both gateways share Bot 1's signals, sizing policy, durable intents, route funding, ledger, reconciliation, quiet hours, risk controls, and exits. For conviction, always use authenticated final quote/depth validation and IOC limit construction; fail closed on stale, changed, mismatched, out-of-zone, or insufficient-depth books.

A marketable IOC limit enforces only the worst acceptable price; it cannot enforce a minimum side cost because Kalshi may price-improve into cheaper resting levels. For a strict entry band, inspect the unfiltered best executable side cost and abort if it is below the floor. Never filter cheaper levels away before deciding whether submission is safe.

The gateway shown as active in the operator UI must come from the server-returned canonical config, not a local unsaved draft. A draft selection must be labeled pending until persistence succeeds.