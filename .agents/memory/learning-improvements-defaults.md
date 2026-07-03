---
name: Learning improvements from production data
description: 4 bot config default changes + requireMonitorReady gate from production data analysis (July 2026)
---

## Rule
When the bot's paper-mode win rate is below the break-even threshold (67% for 1:2 payout),
apply these four guards before going live:
1. `requireMonitorReady: true` — skip first 2 ticks of each window
2. `maxSameDirectionBets: 2` — prevent correlated same-direction clusters
3. `enableBorderGuard: true, borderProximityPct: 3.0` — block near-boundary coins
4. `minConfidence: 67` — match the break-even confidence floor

**Why:** Production data showed 64.1% win rate (below 67% break-even). Root causes:
- Early bets (min 0-1) before WM data is ready
- 4-5 correlated NO bets in rising markets (e.g. 20:00-20:30 window)
- DOGE hovering within 3% of strike → 46% win rate (near-50/50)
- Confidence floor too low (52) letting low-quality signals through

**How to apply:** These are DEFAULT values — existing DB configs override them.
After a fresh deploy the new defaults apply automatically. For existing configs,
user must update via bot settings UI.
