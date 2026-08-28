---
name: Bot 1 low-latency conviction gateway
description: Required execution and latency invariants for Bot 1 conviction entries.
---

Bot 1 conviction execution must always use the authenticated WebSocket book. A stale persisted legacy-gateway setting must not disable the conviction trigger or final quote path.

**Why:** The conviction workflow exists to react immediately and place more qualifying bets. REST quote waits, stale gateway settings, fixed batching timers, and blocking telemetry caused fresh in-zone opportunities to be missed.

**How to apply:** Wake conviction entries from accepted sequence-valid WebSocket updates using current-window cached ticker/strike identity. Read the fresh exact book again at the final gate, then proceed without candidate REST I/O or fixed timer delays.

A marketable IOC limit enforces only the worst acceptable price; it cannot enforce a minimum side cost because Kalshi may price-improve into cheaper resting levels. For a strict entry band, inspect the unfiltered best executable side cost and abort if it is below the floor. Never filter cheaper levels away before deciding whether submission is safe.

The gateway shown as active in the operator UI must come from the server-returned canonical config, not a local unsaved draft. A draft selection must be labeled pending until persistence succeeds.

IOC may authorize fewer contracts than the requested size when only partial complete-contract depth is visible. Cap the submitted count, funding reservation, durable intent, exposure, and downstream accounting to that authorized quantity.

**Why:** Requiring full requested depth prevented valid IOC partial fills and suppressed bets in thin books.

**How to apply:** Final revalidation may accept a newer safe book version when the authorized quantity remains executable at or better than the original fixed limit and within the entry floor. Do not require byte-identical sequence versions.

Skip-history and other observational persistence must be non-blocking. Never hold the per-symbol tick lock behind telemetry while newer authenticated book updates are waiting.

**Why:** A stale scheduled SKIP could wait on the database and silently coalesce fresh actionable WebSocket events.

**How to apply:** A book event that arrives behind an active symbol tick must replace the one pending input and run immediately after the owner releases; routine scheduler input cannot overwrite a pending authenticated input. Deduplicate unchanged selected-side top quotes until the one-second retry floor, but dispatch the first signal and every selected-side price change immediately.

Preserve mandatory exact ticker/strike, fresh sequence-valid book, fixed price limit, route funding, durable ownership, atomic intent, and unknown-fill reconciliation. These correctness boundaries may block; optional analysis and telemetry may not delay broker submission.