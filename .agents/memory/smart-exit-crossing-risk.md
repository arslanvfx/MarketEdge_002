---
name: Smart Exit crossing-risk policy
description: Durable safety and calibration rules for deciding when a winning position may be exited early.
---

Smart Exit must treat a realistic target crossing before expiry as the decisive risk. A Kalshi probability collapse, fast repricing, or ordinary underlying move can warn or prepare, but cannot independently produce an exit signal. A non-crossed target requires sustained adverse direction, realistic distance/volatility reachability, and enough time to execute. An actual target crossing may escalate immediately without waiting for a separate 25% Kalshi loss.

Every executable signal still requires fresh underlying, quote, and order-book evidence; full-position liquidity; positive sell economics; durable owner authorization; and final execution safeguards. PREPARE EXIT remains non-executing.

Live policy and durable replay must use the same pure crossing-risk state transition and cadence continuity rule. Calibration uses authoritative exchange settlement, chronological holdout, and slippage sensitivity; it optimizes total P&L and remains advisory until explicitly applied by an operator.

Deep-loss protection is based on fresh full-position executable sale proceeds versus the actual remaining entry stake. A loss below 80% preserves ordinary policy. From 80% to below 90%, an otherwise valid exit is blocked only when at least 210 seconds remain and volatility-based target recovery is reachable. At 90% or worse, an otherwise valid exit is always blocked so the position resolves. This protection may veto an exit but never create one.

Live authorization is per owner and symbol. Any applied version used for execution must carry the immutable parameter snapshot that replay validated; label-only legacy versions fail closed. Different symbols may be approved or rejected independently, but do not introduce a global target-cross delay from sparse outcomes.

Sensitivity is exposed only through three canonical presets so crossing thresholds cannot drift into invalid combinations. More Aggressive uses 2 confirmations, 0.20 continuation, 0.15 market-loss confirmation, and 0.10 crossing reserve; Default preserves 3/0.35/0.25/0.20; Less Aggressive uses 4/0.50/0.35/0.30. Applied live versions freeze both the preset name and all resolved values; later global changes must not mutate already-authorized policy.

Cross-mode effectiveness comparisons must replay every sensitivity against one identical settled-position/evidence snapshot; explicit caller filters or limits cannot replace the canonical global snapshot. Confirmed fills, observed shadow simulations, and replayed counterfactuals are separate accounting classes. Missing liquidity coverage or quantity mismatch is unscoreable, never assumed executable.

**Why:** The user wants to stop Smart Exit from selling winners early when Kalshi reprices or the underlying makes ordinary noise, without losing protection when the target is genuinely likely to cross. Recent settled triggers showed immediate crossings helped BTC/ETH but shallow ZEC/XRP crossings recovered, so symbol-specific validation is safer than one universal delay.

**How to apply:** Route all future live and replay exit paths through the shared crossing and deep-loss assessments and canonical sensitivity resolver. Treat repricing as confirmation only, preserve fail-closed full-position evidence, use actual remaining stake, and never auto-activate or execute an incomplete replay recommendation.