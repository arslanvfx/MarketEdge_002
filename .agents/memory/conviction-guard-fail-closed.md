---
name: Conviction direction guard fail-closed
description: The conviction direction guard must never be skippable — no usable price data means NO bet, and the guard runs at every dispatch/re-dispatch.
---

# Conviction direction guard — fail-closed contract

**Rule:** The pure gate (`computeConvictionDirectionGate`) returns `blocked:false` with `source:"none"` when neither ≥2 fresh ticks nor ≥2 candles exist. Conviction CALLERS must treat `source==="none"` as a hard block (fail closed), never as a pass. The guard must also be re-evaluated on every fresh dispatch — a failed FOK that releases the conviction lock leads to a re-dispatch that gets its own guard evaluation.

**Why:** The eighth wrong-direction live bet (XRP NO, 2026-08-10 13:45 window) happened because the entire guard was wrapped in `candles.length >= 2` — when candles were missing, the guard was skipped entirely even though fresh poller ticks existed. A prior failed FOK (insufficient resting volume) released the lock and the re-dispatch fired with no guard evaluation visible in logs.

**How to apply:**
- Any new conviction entry path must call the direction guard AND the medium-term candle-slope gate (`computeConvictionCandleSlopeGate`) immediately before order placement, not just at initial dispatch.
- `source`, `sampleCount`, `ageSpanMs` on the gate result are the diagnostics that prove which data drove the decision — keep them in logs.
- Blocks surface via `convictionDirectionGuardBlockedMap` with gate `"tick" | "candle-decline" | "candle-rise" | "no-data"`; the dashboard renders "No data" as a distinct grey badge.
- Candle-slope gate defaults: threshold 0.01%, ATR scaling OFF (a SOL regression showed ATR scaling let an adverse trend through). Route accepts `convictionCandleSlopeGateEnabled/convictionCandleLookback/convictionCandleSlopeThresholdPct/convictionCandleAtrScaleEnabled`; note the BotConfig field is `convictionCandleSlopeLookback`.
- Ticks are evaluated independently of candle availability; candles are only a fallback when ticks are insufficient. Stale ticks (outside the guard window) do NOT count as a tick source.
