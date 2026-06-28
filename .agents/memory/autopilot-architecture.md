---
name: Auto-pilot architecture
description: How the per-coin auto-pilot decision engine works, which coins it applies to, and what it actually controls.
---

## What auto-pilot controls
Auto-pilot does **not** turn Claude on/off at the fetch level. It routes the
**Auto-Pilot consensus signal** in CoinDetail through whichever model has the
proven accuracy edge for that coin.

When `autoPilotDecision.active = true`:  
→ `autoPilotAbove` uses Claude's direction + Claude's historical accuracy as confidence.

When `active = false`:  
→ `autoPilotAbove` uses the stat model's direction + stat's historical accuracy.

## Coin policy
| Coin group | Claude runs? | Auto-pilot applies? |
|---|---|---|
| Training (BTC/ETH/XRP/HYPE/BNB) | Always | Yes — tracks which model wins |
| Non-training (SOL/LINK/DOGE) | Never | No — always "Stat only" |

Non-training coins are stat-only by policy to avoid Claude API costs on coins without a track record.  
`isCoinClaudeEnabled(symbol)` returns `TRAINING_COINS.has(symbol)` — always true for training coins.  
`setCoinClaudeEnabled()` guards non-training coins (no-op + purge).

## Decision engine (autopilot.ts)
Pure function `computeAutoPilotDecisions(inputs)` — no DB, no side-effects, unit-testable.

Guardrails:
- `AUTOPILOT_MIN_SAMPLES = 8` — need a stat baseline before any decision
- `AUTOPILOT_EXPLORE_SAMPLES = 8` — if Claude has fewer bets, briefly mark `exploring=true`
- `AUTOPILOT_ON_MARGIN = 5` — Claude must beat stat by ≥5 pp to turn ON
- `AUTOPILOT_OFF_MARGIN = -2` — stays ON until Claude falls ≥2 pp below stat (hysteresis)
- `AUTOPILOT_MAX_ACTIVE = 3` — global cap; proven winners ranked first, then explorers

## Why
Training coins always run Claude so the self-learning loop builds a real track record.  
Auto-pilot then reads that record and ensures the consensus panel gives better-calibrated
signals by using whichever model is actually winning for each coin.
