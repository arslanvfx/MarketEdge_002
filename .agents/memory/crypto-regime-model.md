---
name: Crypto statistical model — regime-aware drift & calibrated confidence
description: How analyzeCoin adapts drift by regime, why stat-model confidence is heavily shrunk, and what the backtest says is achievable at the 15-min horizon.
---

# Regime-aware statistical crypto model (analyzeCoin)

The per-minute `drift` is a regime-weighted blend, not fixed. Weights scale by a smooth `trendFactor` derived from the intra-window efficiency ratio: trending → momentum + regression dominate; chop → mean-reversion toward recent VWAP + RSI-extreme bias dominates. Volume tilt (recent vs baseline candle volume) nudges trendFactor and is backtestable.

**Spike rule (non-obvious):** the backtest regime classifier checks `spikeFlag` BEFORE efficiency ratio, so spikes are their own bucket. Spikes *continue* over the next 15 min, so on a spike we force trendFactor high to LEAN momentum.
**Why:** an earlier version faded spikes and dropped spike hit rate ~8pp. Do not fade spikes.

**Order book is live-only:** order-book imbalance must be an OPTIONAL param defaulting neutral.
**Why:** there is NO historical L2 data, so any non-neutral default breaks apples-to-apples backtest replay (analyzeCoinAt passes no order book).

# Confidence is deliberately compressed
**Why:** the backtest shows the drift/vol z-score has only a few points of real directional skill at 15 min — high-z windows are NOT more accurate (raw probabilistic confidence claimed 70-90% but actual hit ~49%).
**How to apply:** keep stat-model confidence shrunk and capped to a narrow band near the achievable hit rate. Do NOT restore a wide range — it just reintroduces overconfidence. The Claude path clamps its own confidence separately.

# Achievable performance
~50% overall hit rate is roughly the realistic ceiling for 15-min direction. The edge lives in the drifting regime (reversion toward VWAP, ~53%) and spike continuation (~52%). Deep chop stays near coin-flip (~48%) regardless of reversion anchor tried — treat sub-50% chop as close to irreducible, not a bug. Validate any model change with the backtest endpoints against a pinned `endTime`.
