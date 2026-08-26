---
name: Smart Exit ownership boundary
description: Durable safety rules for analysis-driven early exits across regular and Scalper positions.
---

Smart Exit owns evidence, probability analysis, recommendations, and audit history only. It never owns positions or broker mechanics. Any actionable exit must delegate through the position owner's durable close lifecycle, after exact identity, mode, applied-version, and evidence checks are repeated immediately before submission. Emergency disable must be able to revoke a request after durable claim but before the broker call.

**Why:** Analysis can become stale while durable ownership is being claimed. Reusing another subsystem's close path or checking authorization only before an await creates duplicate-close and wrong-position risks.

**How to apply:** Regular positions may use the canonical regular close lifecycle through a narrow pre-submit guard. Scalper early exits remain observational and blocked until Scalper has its own durable arbitrary early-close intent, unknown-outcome reconciliation, and persistence lifecycle. Recovery scalps are always counterfactual research and never submissions.