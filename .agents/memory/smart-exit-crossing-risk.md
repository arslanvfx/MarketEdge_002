---
name: Smart Exit crossing-risk policy
description: Durable safety and calibration rules for deciding when a winning position may be exited early.
---

Smart Exit must treat a realistic target crossing before expiry as the decisive risk. A Kalshi probability collapse, fast repricing, or ordinary underlying move can warn or prepare, but cannot independently produce an exit signal. A non-crossed target requires sustained adverse direction, realistic distance/volatility reachability, and enough time to execute. An actual target crossing may escalate immediately without waiting for a separate 25% Kalshi loss.

Every executable signal still requires fresh underlying, quote, and order-book evidence; full-position liquidity; positive sell economics; durable owner authorization; and final execution safeguards. PREPARE EXIT remains non-executing.

Live policy and durable replay must use the same pure crossing-risk state transition and cadence continuity rule. Calibration uses authoritative exchange settlement, chronological holdout, and slippage sensitivity; it optimizes total P&L and remains advisory until explicitly applied by an operator.

**Why:** The user wants to stop Smart Exit from selling winners early when Kalshi reprices or the underlying makes ordinary noise, without losing protection when the target is genuinely likely to cross.

**How to apply:** Route all future live and replay exit paths through the shared crossing assessment. Treat repricing as confirmation only, preserve fail-closed execution evidence, and never auto-activate a replay recommendation.