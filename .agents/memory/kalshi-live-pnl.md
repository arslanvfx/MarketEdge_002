---
name: Kalshi contract P&L
description: Settlement and unrealized profit must follow binary-contract economics in every mode.
---

Paper, shadow-paper, and live positions use the same binary-contract settlement math. A winning contract pays $1: profit is `(1 - held-side entry cost) × contracts`; a loss is `-held-side entry cost × contracts`. Do not substitute a fixed percentage of stake in simulation.

**Why:** Fixed paper returns materially overstated expensive contracts—for example, $50 risked at 84¢ was shown as $25 profit instead of about $9.52—and made development performance incomparable with live trading.

**How to apply:** Derive held-side entry cost from direction, use confirmed contract count and fill price, and share one pure calculation across paper, shadow, and live settlement. Mid-window unrealized/exit P&L remains held-side price delta times contracts.