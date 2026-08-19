---
name: Bot config patch semantics
description: Durable clear/update rules for partial bot configuration mutations and dashboard drafts
---

Partial bot-config updates must distinguish three states: an omitted field preserves the stored value, an explicit `null` clears that field to its fallback, and a row-level `null` removes the entire override.

**Why:** Treating omitted and cleared values alike, or overlaying stored values before the merge, silently resurrects settings that an operator intended to clear. Clearing the local draft before persistence is confirmed can also discard the only retryable copy of an edit.

**How to apply:** Let the authoritative merge layer receive the submitted patch unchanged, validate the resulting effective configuration, and return the canonical persisted config. The client should keep its draft on failure and replace its baseline with that canonical response only after confirmed persistence.