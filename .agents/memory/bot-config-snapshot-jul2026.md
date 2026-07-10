---
name: Bot Config Snapshot — July 2026
description: Pre-position-confirm architecture snapshot; restore these values to fully revert.
---

# Bot Config Snapshot — Pre Position-Confirm Refactor (July 10, 2026)

Captured before switching to "position_confirm" decision mode and adding priceBufferPct.

## Key values in effect (DEFAULT_BOT_CONFIG + any live overrides)

| Field | Default | Notes |
|---|---|---|
| decisionMode | "classic" | Switch back to revert architecture |
| minConfidence | 70 | Core entry gate |
| betDelayMinutes | 0 | No delayed entry |
| maxEntryMinutes | 0 | No ceiling |
| minRemainingMinutes | 2 | 2-min floor |
| windowEntryBufferSeconds | 60 | 1-min window-open hold |
| maxBetsPerWindow | 7 | Matches 7-coin training set |
| consensusMinCents | 25 | Kalshi market price gate |
| priceBufferPct | 0 | NEW field — 0 = disabled (reverts to pure signal mode) |
| enableBorderGuard | true | |
| borderProximityPct | 3.0 | |
| enableDirectionCap | true | |
| maxSameDirectionBets | 2 | |
| regimePenalty | 0 | Each window independent |
| requireMonitorReady | true | |
| mlVetoMinConfidence | 57 | |
| coinStreakLossLimit | 3 | |
| coinStreakPauseWindows | 2 | |
| coinStreakPenalty1LossPp | 6 | |
| coinStreakPenalty2PlusLossPp | 12 | |
| unanimousMinModelConfidence | 57 | |
| directionalRegressionThreshold | 0.35 | |
| directionalRegressionPenaltyPp | 10 | |
| betProfile | "normal" | |
| enableMidExit | false | |
| freeRunMode | false | |
| minNoEntryMinutes | 1 | |
| minReturnMultiple | 1.45 | |

## How to fully revert

1. In the Bot Config UI → Decision Logic: select **Classic**
2. Set **Earliest Entry** → Immediately (betDelayMinutes: 0)
3. Set **Latest Entry** → No ceiling (maxEntryMinutes: 0)
4. Set **Price Buffer** → 0% (disables position-confirm gate entirely)
5. Set minConfidence back to 70 if you changed it

## What changed in this refactor

- Added `priceBufferPct` field (0 = disabled, position-confirm gate off)
- Added `"position_confirm"` decision mode
  - Price position vs strike = primary direction signal
  - Models become soft vetoes: ≥2 disagree → SKIP
  - Confidence = 60 + (5 × agreeing models) + min(distance% × 5, 10)
- `livePrice` now passed through to the engine from the tick loop
