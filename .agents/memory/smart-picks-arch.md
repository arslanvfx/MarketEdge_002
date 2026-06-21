---
name: Smart Picks architecture
description: Key rules for how the Smart Picks optimizer handles Kalshi vs Polymarket, same-game combos, and non-sport markets
---

## Platform rules
- **Polymarket**: always single-bet mode (`forceSingle = true`). Gamma feed has no event grouping / combo pricing; parlaying polymarket legs is unreliable.
- **Kalshi sports** (Soccer/Basketball/Baseball/Football/Hockey/Tennis/Golf/MMA/Boxing/Cricket/Rugby): multi-leg combos OK, including same-game prop combos.
- **Kalshi non-sport** (Economics/Crypto/Politics/Tech/etc.): single-bet only. Platform restriction — these markets can't be parlayed.

## Same-game combos (Kalshi)
- `gameKey` = eventTicker suffix after stripping series prefix, only for dated tickers matching `^\d{2}[A-Z]{3}\d{2}` (e.g. `26JUN27COLPOR`). Outrights/futures → null.
- `eventTicker` = the underlying market (every outcome/threshold shares it). Same eventTicker = blocked from parlaying.
- Same `gameKey`, different `eventTicker` = legitimate same-game prop combo (winner + total + BTTS + corners…).
- After `pickBalanced()` in combos.ts, every Kalshi game in the pool has its prop siblings (same gameKey) pulled in from the full liquid set up to `EXPANDED_CAP=90`.

## Correlation rules in legsAreCorrelated()
1. Same `eventKey` → always blocked.
2. Non-game markets (gameKey=null): title-family guard blocks same market at different thresholds.
3. Within one competition: if any leg `isOutright` → blocked (outright correlates with every game).
4. Two different games of same competition → allowed (normal multi-game parlay).

**Why:** Multiplying probabilities as if independent is statistically invalid when legs are correlated; the platform also won't let you place correlated parlays.
