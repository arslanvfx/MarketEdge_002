---
name: Scalper study durable outbox
description: Reliability rule for prospective observational records that must not delay or alter the normal Scalper path.
---

Prospective Scalper studies that originate from a normal skipped attempt must store a JSON-safe study payload atomically with the normal reservation's skip evidence, preserve that first payload across every re-claim and later outcome, then replay it asynchronously into the study table with an idempotent key.

**Why:** Bounded fire-and-forget database retries preserve execution isolation but can still lose an eligible observation during a split failure or process restart. Re-claiming the normal reservation can also erase a still-pending payload unless the study evidence is immutable. The normal skip record is already the durable boundary and can act as an outbox without placing experimental writes on the order path.

**How to apply:** Preserve the first study payload whenever the reservation is re-armed, skipped again, filled, or finalized. Replay missing post-tracking payloads regardless of the reservation's current status, and deduplicate on the study's natural scope. Never let replay, reporting, or study failures affect reservations, caps, orders, or broker submission.