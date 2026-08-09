---
name: Conviction late-window retry
description: Conviction mode must keep monitoring/retrying blocked coins through end of window; floors and cap mismatches that broke it
---

Rule: conviction mode bypasses ALL min-remaining/late-entry floors unconditionally (`decisionMode !== "conviction"` added to the three `!allowLateEntries` gates in tick.ts ×2 and loop.ts), and every abort path in the conviction live-price gate MUST release `convictionFiredThisWindow` and restore the max-bet token.

**Why:** (1) The poller ticker-mismatch branch returned without releasing the lock/token — one mismatch permanently blocked the coin for the window and leaked the max-bet slot. (2) Phase 3's `computeStrikeProximityGate` used the default `atrMultiplierCap` (2×) while the tick re-check used 1.2× — Phase 3 could block coins the tick would allow, so they were never dispatched. (3) The floors stopped monitoring ~min 12+ even though a zone re-entry with 1–3 min left is exactly what conviction targets.

**How to apply:** any new abort/skip branch between the `convictionFiredThisWindow.add()` (synchronous, pre-await) and order placement must mirror the sibling branches: delete the lock key, restore the token when `boostBetSize != null`. Any new proximity-gate call site must pass `atrMultiplierCap: 1.2` to stay in sync.
