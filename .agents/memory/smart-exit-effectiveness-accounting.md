---
name: Smart Exit effectiveness accounting
description: Durable rules for measuring Smart Exit execution and decision quality.
---

A Smart Exit trigger, execution, and effectiveness verdict are separate lifecycle facts. Trigger time is immutable per exact owner position; shadow observations remain advisory; unknown order outcomes remain unknown.

**Why:** A confirmed fill proves that execution worked, but it does not prove the decision helped. That requires comparing actual exit value with the value from authoritative Kalshi settlement, without changing canonical trading P&L.

**How to apply:** Reconcile filled exits against authoritative market settlement. Freeze counterfactual proceeds at every trigger only when fresh evidence covers the full position; use them to score advisory, blocked, and confirmed zero-fill recommendations after settlement. Requested and unknown submissions remain unresolved, never hypothetical. Persist recovered legacy economics before evaluation history can disappear. Report saved loss, missed win, reduced profit, no difference, or pending explicitly. Keep the ledger idempotent across one-second evaluations and server restarts. Transaction history must join effectiveness by exact durable position identity, label executed paper exits as Smart Exit stop losses, and keep live close semantics unchanged.

The regular dashboard decision scorecard uses only **Total Saved** and **Profit Left on the Table**, aggregated across every settled scoreable signal. It must not substitute the confirmed-fill-only subgroup, show net/actual/shadow headline values, or use “gross” in user-facing labels.

**Why:** Operators judge decision quality by loss avoided versus profit forfeited. Confirmed-fill-only totals hid blocked but fully executable scored signals and made the five-bet results appear as zero.

**How to apply:** Total Saved is the sum of positive exit-versus-hold differences; Profit Left on the Table is the absolute sum of negative differences. Use actual confirmed proceeds for fills and frozen executable proceeds for blocked/advisory/zero-fill signals. Label replay separately because it always uses frozen policy-trigger evidence.