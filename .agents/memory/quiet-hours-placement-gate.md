---
name: Quiet-hours placement-time gate
description: Smart Hours must be enforced at the moment an order is placed, not only when the tick/loop starts; auto-tune config writes must merge per-cell deltas.
---

# Quiet-hours placement-time gate

**Rule:** Loop-level quiet-hours checks are an optimization, never the safety boundary. Some entry paths dispatch ticks directly and skip the loop entirely, and a tick can cross an hour boundary between sizing and order submission. Therefore:
1. The quiet-hours decision is re-resolved fail-closed immediately before order submission. A silenced hour blocks the order (and releases any conviction lock / max-bet token); the shadow-paper bypass may only demote a live entry to paper — it must never permit a live order.
2. The reduced-bet percentage is also re-resolved at placement time; if the hour became stricter after sizing, the contract count is rescaled down (most-conservative-wins — a reduced→active crossing never inflates the bet). If the stricter budget buys <1 contract, the order is rejected.

**Why:** Live bets fired in an hour the operator believed was off (it was actually "reduced", and enforcement only existed at loop level). Any single-point check earlier than the order call leaves hour-transition and direct-dispatch gaps.

**How to apply:** any new entry path or timer gets this for free if it goes through the standard tick. Any future code that places orders outside the tick must re-resolve the quiet-hours decision (silenced + reduced) itself right before the order call.

**Auto-tune merge rule:** auto-tune must compute per-cell silence/unsilence deltas from its pre-query snapshot and apply them onto the freshest config at write time — never overwrite the whole per-day map, or a manual slot toggle saved during the aggregation query gets clobbered.
