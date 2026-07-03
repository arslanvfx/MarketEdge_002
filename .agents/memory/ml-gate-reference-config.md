---
name: ML Gate Reference Configuration
description: Complete specification of ml_gate mode — engine constants, bot config, and logic. Use this as the canonical restore point whenever switching decisionMode to ml_gate.
---

# ML Gate Reference Configuration

> **Intent:** When the user says "switch to ML Gate mode", restore ALL of these exact values.
> Last captured: 2026-07-03 from live DB + source code.

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

## How ml_gate Mode Works (kalshi-bot-engine.ts)

ml_gate is fundamentally different from classic:

1. **Direction is decided by Stat + Claude alone** — ML is excluded from PATH A. ML cannot promote itself to lead direction.
2. **ML acts only as a gatekeeper (veto)** after the core pair picks a direction:
   - If ML **agrees** or is **unavailable** → bet proceeds, ML annotated in reasoning
   - If ML **disagrees** and `mlConfidence >= mlVetoMinConfidence (57%)` → **hard SKIP** ("ML veto")
   - If ML **disagrees** but `mlConfidence < 57%` → **bet proceeds** (ML too uncertain to block — "veto skipped")
3. Falls through to the same PATH B / PATH C logic as classic when the core pair can't decide.

**Key behavioural difference from classic:** In classic, ML can lead when confident (PATH A). In ml_gate, ML never leads — it only blocks.

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
| `mlVetoMinConfidence` | **57%** | ML must be at least this confident to exercise its veto in ml_gate mode |
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

**Why:** The user explicitly requested that ml_gate be the reference mode. ml_gate is considered more conservative than classic because ML cannot lead direction (only veto), meaning Stat+Claude must form an agreement first. This reduces the number of bets in ambiguous markets where ML is the only signal.

**How to apply:** When the user says "switch to ML Gate" or "switch to ML Logic", set `decisionMode = "ml_gate"` and verify all other fields match this table. Do NOT adjust mlVetoMinConfidence without being told — 57% is the calibrated soft-veto threshold.
