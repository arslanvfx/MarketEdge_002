---
name: Scalper reversal and target-distance guards
description: Safety invariants for adverse reversals and entries near the Kalshi target.
---

The High-Value Scalper Freefall guard must retain its oldest-to-newest adverse-move check and also compare the newest underlying price with the recent peak for YES or recent trough for NO.

**Why:** An endpoint-only lookback can appear favorable after the underlying first moves toward the target and then reverses sharply just before entry.

**How to apply:** Run the side-aware check at the final pre-order boundary and fail closed on missing, stale, invalid, insufficient, or unordered samples. A guard skip may re-arm only after the bounded guard cooldown and must pass a fresh check before any order.

The target-distance guard is independently toggleable, defaults on at 0.05%, and uses `abs(live - target) / abs(target) * 100`.

**Why:** When the underlying is extremely close to the strike, a high-priced side can flip quickly even if the Kalshi quote remains inside the configured execution band.

**How to apply:** Use a freshly collected underlying sample and the force-refreshed exact-window Kalshi target immediately before sizing and order-intent creation. Missing inputs fail closed. Pin the toggle and threshold in the execution risk snapshot, and never label a guarded market as an active candidate.

Safety proofs for final-entry guards must execute the real service attempt boundary with injected persistence and broker sinks; test-local intent/submission counters are not sufficient.

**Why:** A duplicated simulator can prove its own ordering while production still creates an order intent or calls the broker before the guard returns.

**How to apply:** Invoke the actual reservation-to-submit function with an injected clock and in-memory sink spies. Assert the service cooldown state suppresses retries, then show fresh valid samples reach a stubbed broker only after expiry.