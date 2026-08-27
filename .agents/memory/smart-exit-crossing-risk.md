---
name: Smart Exit crossing-risk policy
description: Durable safety and calibration rules for deciding when a winning position may be exited early.
---

Smart Exit aggression scales from exact seconds remaining. A target crossing never authorizes an exit by itself. Underlying direction/distance and fresh held-side Kalshi deterioration must agree; flat, strengthening, stale, or missing Kalshi direction blocks execution.

The canonical bands are monitor above 240 seconds, escalation at 181–240, urgent at 61–180, and critical at 0–60. Minimum adverse excursions/latches are respectively 0.35%/4s, 0.20%/6s, 0.075%/8s, and 0.02%/10s. Critical may act on a sharp projected crossing before the target, but still requires independent underlying confirmation and fresh Kalshi corroboration.

Every executable signal still requires fresh underlying, quote, and order-book evidence; full-position liquidity; positive sell economics; durable owner authorization; and final execution safeguards. Final live submission re-runs fresh spot/trajectory/target policy before claim, before depth, and immediately before submit. PREPARE EXIT remains non-executing.

Live policy and durable replay use the same event-time trajectory, latch, recovery, time-band, and crossing-risk transitions. Duplicate spot events preserve a recent adverse latch without adding proof; duplicate Kalshi events may retain diagnostic count but are flat and non-confirming for execution. Genuine recovery, stale/out-of-order evidence, or latch expiry clears spot risk. Calibration remains chronological, settlement-authoritative, slippage-aware, and advisory.

The hot ticker lane is isolated from slower full-evidence collection. Per-position evaluation accepts nondecreasing spot event times and is serialized/coalesced. Slow spot, tape, and L2 inputs are reusable only when transport and exchange event times are fresh. Missing volatility, momentum, or book imbalance makes a crossing UNAVAILABLE; trade flow is optional only in the critical band when all other independent and execution evidence agrees.

Deep-loss protection is based on fresh full-position executable sale proceeds versus the actual remaining entry stake. A loss below 80% preserves ordinary policy. From 80% to below 90%, an otherwise valid exit is blocked only when at least 210 seconds remain and volatility-based target recovery is reachable. At 90% or worse, an otherwise valid exit is always blocked so the position resolves. This protection may veto an exit but never create one.

Live authorization is per owner and symbol. Any applied version used for execution must carry the immutable parameter snapshot that replay validated; label-only legacy versions fail closed. Different symbols may be approved or rejected independently, but do not introduce a global target-cross delay from sparse outcomes.

Sensitivity is exposed only through three canonical presets so crossing thresholds cannot drift into invalid combinations. More Aggressive uses 2 confirmations, Default 3, and Less Aggressive 4 for the projected-crossing path; no preset may bypass monitor recovery protection, time-band distance, Kalshi confirmation, or execution safeguards. Applied live versions freeze both the preset name and all resolved values.

Cross-mode effectiveness comparisons must replay every sensitivity against one identical settled-position/evidence snapshot; explicit caller filters or limits cannot replace the canonical global snapshot. Confirmed fills, observed shadow simulations, and replayed counterfactuals are separate accounting classes. Missing liquidity coverage or quantity mismatch is unscoreable, never assumed executable.

**Why:** The user confirmed that 15-minute markets need room to recover early. In one production window, three of four positions signaled: two eventual winners exited on tiny crosses while held-side Kalshi probability was flat near 96–99%, and ETH exited on a 0.0072% cross with 231 seconds left.

**How to apply:** Route live and replay through shared trajectory, time-band, market-direction, crossing, and deep-loss assessments. Keep hot/slow collectors isolated, reject older event-time evaluations, serialize state per position, and persist through one ordered writer. Honor immutable evidence ages and preserve fail-closed execution evidence.