---
name: Smart Exit ownership boundary
description: Durable safety rules for analysis-driven early exits across regular and Scalper positions.
---

Smart Exit owns evidence, probability analysis, recommendations, and audit history only. It never owns positions or broker mechanics. Any actionable exit must delegate through the position owner's durable close lifecycle, after exact identity, mode, applied-version, and evidence checks are repeated immediately before submission. Emergency disable must be able to revoke a request after durable claim but before the broker call.

A live recommendation must freeze its economic floor and evidence-expiry deadline at decision time. The owner must re-fetch authenticated depth, prove the full quantity remains executable at that immutable winning-side floor, and submit a side-aware bounded FOK limit. Never recompute the floor from mutable config after an await or use an unreferenced aggressive close.

**Why:** Analysis can become stale while durable ownership is being claimed. Reusing another subsystem's close path or checking authorization only before an await creates duplicate-close and wrong-position risks. A marketable fallback can also fill below the sale value that justified the exit.

**How to apply:** Regular positions may use the canonical regular close lifecycle through a narrow pre-submit guard plus an immutable economic constraint. Scalper early exits remain observational and blocked until Scalper has its own durable arbitrary early-close intent, unknown-outcome reconciliation, and persistence lifecycle. Recovery scalps are always counterfactual research and never submissions.