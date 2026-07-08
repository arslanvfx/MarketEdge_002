---
name: ML Gate Reference Configuration
description: Complete specification of ml_gate mode — engine constants, bot config, and logic. Use this as the canonical restore point whenever switching decisionMode to ml_gate.
---

# ML Gate Reference Configuration

> **Intent:** When the user says "switch to ML Gate mode", restore ALL of these exact values.
> Last captured: 2026-07-08 from live DB + source code (post three-tier-formula rewrite).
> **Status:** Active. minConfidence is 60 in the current dev config; auto-tune may move it — always read the live value, the composite gate uses whatever is in config.

---

## Engine Constants (kalshi-bot-engine-core.ts)

These live in code and cannot be changed from the dashboard. They are the same for all decision modes.

| Constant | Value | Meaning |
|---|---|---|
| `ML_PRIMARY_MIN_CONFIDENCE` | **62%** | ML must reach this confidence to be eligible to lead direction (PATH A in classic) |
| `ML_SIGNAL_BOOST` | **+6pp** | Each agreeing validator (Claude, Stat, WM) adds this to ML's base confidence score |
| `BASE_CONFIDENCE_FULL_PAIR` | **65%** | Base confidence when Claude + Stat both agree (PATH B full pair) |
| `BASE_CONFIDENCE_HALF_PAIR` | **60%** | Base confidence when only one of Claude/Stat is available |
| `CONFIDENCE_BOOST_PER_SIGNAL` | **+8pp** | WM agreement boost in PATH B / PATH C |
| `WINDOW_ENTRY_BUFFER_S` | **45 seconds** | Hard buffer from window open before any bet entry is allowed |

---

## How ml_gate Mode Works (as of 2026-07-08 — simplified three-tier formula)

ml_gate uses `computeMLGateDecision` in engine-core.ts (NOT computeCorePairDecision — classic keeps that). Linear formula, no path matrix:

1. **Gate 1 — all three signals required**: Stat, Claude, and ML must all be non-null (tick loop already waits via getLatestCoinSignals; the formula re-checks).
2. **Direction = Claude's direction.** Claude is the primary direction setter; ML never leads.
3. **ML veto**: SKIP only when `mlAbove !== claudeAbove && mlConf > claudeConf` (strictly greater). Low-conviction ML dissent never blocks. `mlVetoMinConfidence` is NO LONGER used anywhere (field kept in BotConfig for DB compat only).
4. **Confidence** = `claudeConf + (ML agrees ? +ML_BOOST(8) : 0) + (Stat agrees ? +STAT_BOOST(4) : −STAT_PENALTY(4))`.
5. **Gate 4**: composite ≥ `minConfidence` (from live config; 60 as of 2026-07-08) → BET, else SKIP.
6. **Post-gates** (same as classic): direction-aware EV floor (YES −0.05 / NO −0.15) and minReturnMultiple gate.

**No Gate 2 per-signal floors in ml_gate** — the composite gate is the only quality filter. Constants ML_BOOST/STAT_BOOST/STAT_PENALTY live in engine-core.ts and are re-exported through the kalshi-bot-engine.ts barrel.

**Key behavioural difference from classic:** In classic, ML can lead when confident (PATH A). In ml_gate, ML never leads — it only vetoes, and only when more confident than Claude.

---

## Bot Config — Exact Values to Use with ml_gate

These are the live DB values captured at the time of this snapshot. When switching to ml_gate, set decisionMode to `ml_gate` and confirm all other values match.

| Field | Value | Notes |
|---|---|---|
| `decisionMode` | **`ml_gate`** | ← the switch |
| `minConfidence` | **60** | Minimum effective confidence to place a bet |
| `betSize` | **$1.00** | Dollar amount per bet |
| `dailyLossLimit` | **$20** | Stop new entries if daily P&L reaches this loss |
| `maxBetsPerWindow` | **6** | Max bets per 15-min window |
| `regimePenalty` | **15pp** | Deducted when betting against recent settlement regime |
| `mlVetoMinConfidence` | **57%** | UNUSED since 2026-07-08 three-tier formula (veto is now confidence-relative: mlConf > claudeConf). Field kept in BotConfig for DB compat only — value is inert |
| `maxSameDirectionBets` | **6** | Direction cap per window (YES or NO) |
| `enableDirectionCap` | **true** | Direction cap is active |
| `enableMomentumFilter` | **true** | Momentum filter active |
| `momentumWindowCount` | **3** | Consecutive windows required to trigger momentum filter |
| `midExitSensitivity` | **balanced** | Exit guard sensitivity |
| `phase2ThresholdPp` | **30** | pp below entry to activate Phase 2 exit checks |
| `minRemainingMinutes` | **2** | Don't enter when fewer than 2 minutes remain in window |
| `maxEntryMinutes` | **0** | No ceiling — can enter at any point in window |
| `enableAutoTuning` | **true** | Self-learning auto-tune enabled |
| `autoTuneWindowSize` | **100** | Most-recent settled bets analysed for auto-tune |
| `enableBorderGuard` | **false** | Border proximity guard disabled |
| `borderProximityPct` | **0.1%** | (inactive — borderGuard off) |
| `borderLookbackBets` | **3** | (inactive — borderGuard off) |
| `maxConsecutiveLosses` | **0** | Circuit breaker disabled |
| `circuitBreakerPauseWindows` | **2** | Windows to skip when circuit breaker fires (disabled since maxConsecutiveLosses=0) |
| `quietHoursStart` | **0** | Quiet hours disabled (start === end when both = same value, but here start=0 / end=4) |
| `quietHoursEnd` | **4** | See quietHoursStart note |
| `paperStartingBalance` | **$100** | Paper wallet starting balance |
| `paperWinReturnRate` | **0.50** | +50¢ profit per $1 bet won in paper mode |
| `paperBalanceResetAt` | **null** | Count all bets (no manual reset) |
| `signalThreshold` | **2** | Legacy field — not used for entry gating; kept for config compat |

---

## Why ml_gate vs classic

**Why:** The user explicitly requested that ml_gate be the reference mode. ml_gate is considered more conservative than classic because ML cannot lead direction (only veto), meaning Claude sets direction and the composite gate filters quality. This reduces the number of bets in ambiguous markets where ML is the only signal.

**How to apply:** When the user says "switch to ML Gate" or "switch to ML Logic", set `decisionMode = "ml_gate"` and verify all other fields match this table. The veto has no configurable threshold anymore — it is purely confidence-relative (mlConf > claudeConf on disagreement).

**Bot Steps UI note:** the dashboard's Bot Steps panel (pipeline-status endpoint) mirrors this exact formula for display; if the formula changes, update the route's botSteps math too.
