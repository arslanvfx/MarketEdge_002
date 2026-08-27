---
name: Smart Exit crossing-risk policy
description: Durable safety and calibration rules for deciding when a winning position may be exited early.
---

Smart Exit aggression scales from exact seconds remaining. A target crossing never authorizes an exit by itself. Underlying direction/distance and fresh held-side Kalshi deterioration must agree; flat, strengthening, stale, or missing Kalshi direction blocks execution.

The canonical bands are monitor above 180 seconds, escalation at 121–180, urgent at 61–120, and critical at 0–60. Monitor permits only extreme adverse displacement beyond a percentage floor and volatility-scaled recovery reach. Escalation and urgent require a material continued crossing. Critical may act on a sharp projected crossing before the target, but still requires sustained adverse movement and Kalshi corroboration.

Every executable signal still requires fresh underlying, quote, and order-book evidence; full-position liquidity; positive sell economics; durable owner authorization; and final execution safeguards. PREPARE EXIT remains non-executing.

Live policy and durable replay must use the same pure crossing-risk state transition and cadence continuity rule. Calibration uses authoritative exchange settlement, chronological holdout, and slippage sensitivity; it optimizes total P&L and remains advisory until explicitly applied by an operator.

The bounded independent evidence collector must warm every supported crypto before exposure and continue across Smart Exit mode changes, including OFF. An actual target crossing with missing volatility, momentum window, trade flow, or book imbalance is explicitly UNAVAILABLE in both live evaluation and replay; it is never PREPARE EXIT and never executable from partial warm-up evidence.

Deep-loss protection is based on fresh full-position executable sale proceeds versus the actual remaining entry stake. A loss below 80% preserves ordinary policy. From 80% to below 90%, an otherwise valid exit is blocked only when at least 210 seconds remain and volatility-based target recovery is reachable. At 90% or worse, an otherwise valid exit is always blocked so the position resolves. This protection may veto an exit but never create one.

Live authorization is per owner and symbol. Any applied version used for execution must carry the immutable parameter snapshot that replay validated; label-only legacy versions fail closed. Different symbols may be approved or rejected independently, but do not introduce a global target-cross delay from sparse outcomes.

Sensitivity is exposed only through three canonical presets so crossing thresholds cannot drift into invalid combinations. More Aggressive uses 2 confirmations, Default 3, and Less Aggressive 4 for the projected-crossing path; no preset may bypass monitor recovery protection, time-band distance, Kalshi confirmation, or execution safeguards. Applied live versions freeze both the preset name and all resolved values.

Cross-mode effectiveness comparisons must replay every sensitivity against one identical settled-position/evidence snapshot; explicit caller filters or limits cannot replace the canonical global snapshot. Confirmed fills, observed shadow simulations, and replayed counterfactuals are separate accounting classes. Missing liquidity coverage or quantity mismatch is unscoreable, never assumed executable.

**Why:** The user confirmed that 15-minute markets need room to recover early. In one production window, three of four positions signaled: two eventual winners exited on tiny crosses while held-side Kalshi probability was flat near 96–99%, and ETH exited on a 0.0072% cross with 231 seconds left.

**How to apply:** Route live and replay through the shared time-band, market-direction, crossing, and deep-loss assessments. Replay must honor each evaluation’s immutable evidence-age limit. Keep evidence collection independent, preserve fail-closed execution evidence, and never activate sparse per-symbol calibration automatically.