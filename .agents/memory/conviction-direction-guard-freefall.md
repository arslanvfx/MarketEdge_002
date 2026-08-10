---
name: Conviction direction guard freefall blind spot
description: Why the tick direction guard must check a broader recent horizon, not just the last few seconds
---

The conviction direction guard (`computeConvictionDirectionGate`) originally
evaluated only ticks within a ~7 s short window (`minSeconds + 3`). A price in
freefall toward the strike that went flat for the last few seconds at the
instant of entry produced `slopePrice: 0` over that 7 s window → the guard
passed ("moving away from strike — OK") and a wrong-way conviction bet filled.
Real incident: Aug 10 2026 ETH NO — logged `ageSpanMs: 5360, slopePrice: 0`
while spot had been rising toward the strike for ~80 s.

**Rule:** the tick path evaluates a broader recent horizon
(`trendWindowSeconds`, default 90 s, clamp 15–300, 0 disables) ALONGSIDE the
short window. Block when EITHER slope is adverse. `toPrice` is always the most
recent tick, so a genuine reversal (net move now favorable) does not block.
Direction convention is strike-agnostic: YES adverse = falling (slope<0),
NO adverse = rising (slope>0).

**Why:** the candle-slope gate (5-min resolution) can report a mildly favorable
slope while a sub-minute freefall is underway — a blind spot between the 7 s
tick window and the 5-min candle horizon. The 90 s trend window closes it.

**How to apply:** any change to the direction guard must preserve the two-horizon
check. The poller keeps ~5 min of ticks (`convictionPriceTicks`), so the broader
horizon data is already available; do not shorten tick retention below the trend
window. When the diagnostic logs a block, `slopePrice`/`fromPrice` reflect
whichever horizon triggered it (trend slope surfaces when only the trend blocks).
