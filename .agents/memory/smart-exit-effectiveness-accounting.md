---
name: Smart Exit effectiveness accounting
description: Durable rules for measuring Smart Exit execution and decision quality.
---

A Smart Exit trigger, execution, and effectiveness verdict are separate lifecycle facts. Trigger time is immutable per exact owner position; shadow observations remain advisory; unknown order outcomes remain unknown.

**Why:** A confirmed fill proves that execution worked, but it does not prove the decision helped. That requires comparing actual exit value with the value from authoritative Kalshi settlement, without changing canonical trading P&L.

**How to apply:** Reconcile filled exits against authoritative market settlement. Score shadow exits only when fresh executable evidence covers the full position, and freeze those proceeds at the first trigger. Persist recovered legacy economics before evaluation history can disappear. Report saved loss, missed win, reduced profit, no difference, or pending explicitly. Keep the ledger idempotent across one-second evaluations and server restarts. Transaction history must join effectiveness by exact durable position identity, label executed paper exits as Smart Exit stop losses, and keep live close semantics unchanged.