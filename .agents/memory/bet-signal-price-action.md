---
name: Bet signal / Price Action panel
description: The /predictor bet signal is an intra-window momentum read, not a gap-vs-ATR margin signal
---

# Bet signal = intra-window momentum (Price Action panel)

The `/predictor` per-coin bet signal is driven by **intra-window momentum** over the
last 15 1-min candles, NOT the old gap-vs-ATR "margin signal" (which was removed).

Backend (`crypto.ts` `intraWindowMetrics`) emits on `indicators`: `efficiencyRatio`
(|net move| ÷ total path), `oscillationCount`, `netDriftPct`, `totalPathPct`,
`spikeFlag`, `spikeMultiple`. Frontend `computeBetSignal` maps ER → level: trending
≥0.55 / drifting 0.25–0.54 / choppy <0.25, and `spikeFlag` overrides all to "spike".

These same metrics are ALSO fed into Claude's prediction prompts (an
`intraWindowBlock()` helper in `crypto.ts`, injected into both the multi-forecast
refine prompt and the single snapped-prediction prompt) with instructions to lower
confidence in CHOPPY / low-ER windows and treat spike candles as possible one-off
blips. So the Price Action read drives both the UI signal AND the AI's confidence.

**Why:** ATR14 is an average across all sessions — it says nothing about what price
is doing *right now* inside the current 15-min window, so the old margin signal was
almost always "Too Close"/"Borderline" and gave no edge.

**How to apply:**
- Coins without a Kalshi market (LINK, DOGE) still get ER/spike — gate panels on
  `indicators.efficiencyRatio != null`, not on `kalshiTarget`.
- `driftTowardTarget` means literal direction toward the strike = flip risk (shown
  red ⚠); drift away widens the gap = safer (green ✓). Keep label, color, and the
  `aboveTarget ? !driftUp : driftUp` math in agreement — they were inverted once.
- Spike math guards `medRange === 0`: lone move on otherwise-flat candles uses a
  capped multiple sentinel (99), never `Infinity` (JSON-serializes to null).
