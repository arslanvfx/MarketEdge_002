---
name: Sequential pipeline decision architecture
description: The strict 4-gate pipeline that replaced PATH A/B/C in computeCorePairDecision.
---

# Sequential pipeline decision architecture

All three models must provide a direction and meet per-signal minimums before any bet fires.
No fast-agreement bypass — Claude=null is always a hard SKIP at Gate 1.

## The gates (in order)

**Gate 1 — All three required**
- Stat=null → SKIP "Pipeline … waiting for Stat"
- Claude=null → SKIP "Pipeline … waiting for Claude"
- ML=null → SKIP "Pipeline … waiting for ML"

**Gate 2 — Per-signal confidence minimums**
- Stat < STAT_REQUIRED_MIN_CONF (55%) → SKIP
- Claude < CLAUDE_REQUIRED_MIN_CONF (55%) → SKIP
- ML < ML_REQUIRED_MIN_CONF (65%) → SKIP

**Gate 3 — Direction agreement** (3 branches, checked in order)
- (A) Unanimous: all three same direction → bet; confidence = mlConf + 2×ML_SIGNAL_BOOST (+ CONFIDENCE_BOOST if WM agrees)
- (B) Stat+Claude agree, ML opposes: ML ≥ ML_OVERRIDE_MIN_CONF (70%) → ML overrides, confidence = mlConf alone; below 70% → SKIP
- (C) Stat ≠ Claude → hard SKIP ("Models disagree"), regardless of ML confidence

**Gate 4 — Final minimum confidence**
- composite confidence < minConfidence → SKIP (action=SKIP but confidence value preserved)

## Constants

```ts
STAT_REQUIRED_MIN_CONF   = 55
CLAUDE_REQUIRED_MIN_CONF = 55
ML_REQUIRED_MIN_CONF     = 65
ML_OVERRIDE_MIN_CONF     = 70
ML_SIGNAL_BOOST          = 6   // each confirming validator adds this
CONFIDENCE_BOOST_PER_SIGNAL = 8 // WM bonus
```

Minimum passing unanimous: 65+6+6=77 → clears default minConfidence=70.
Minimum passing unanimous+WM: 77+8=85.

## Key invariants

- **Stat ≠ Claude is always a hard SKIP.** There is no ML tiebreaker for stat-claude disagreement. Gate 3C fires before Gate 3B.
- **ML override requires ≥70%.** At 65-69%, stat+claude consensus wins (SKIP, not bet).
- **WM never vetoes.** Opposing WM adds zero penalty; agreeing WM adds CONFIDENCE_BOOST_PER_SIGNAL.
- **No fast-agreement path.** engine.ts unconditionally skips when claudeAbove=null.

**Why:** Old PATH A/B/C allowed ML to lead alone, stat+claude to bet without ML, and ML to tiebreak stat-claude conflicts. All three modes created bet patterns that underperformed. The sequential pipeline forces all three models to agree on a direction before any money moves.

**How to apply:** Any decision mode that uses `computeCorePairDecision` inherits all four gates automatically. Only `computeCorePairDecision` in engine-core.ts implements this logic.

**NOTE (2026-07-08):** ml_gate mode NO LONGER uses `computeCorePairDecision`. It now calls the separate `computeMLGateDecision` (simplified three-tier formula: Claude leads direction, ML vetoes only if it disagrees AND mlConf > claudeConf, Stat is ±4 modifier, ML agreement +8; no Gate 2 per-signal floors). See ml-gate-reference-config.md. Classic mode still uses computeCorePairDecision with all gates above.

## Test patterns

Tests use helper functions to satisfy Gate 1+2 before testing downstream logic:
```ts
const evYes = (extra) => inp({ statAbove: true,  statConfidence: 55, claudeAbove: true,  claudeConfidence: 55, mlAbove: true,  mlConfidence: 70, ...extra });
const evNo  = (extra) => inp({ statAbove: false, statConfidence: 55, claudeAbove: false, claudeConfidence: 55, mlAbove: false, mlConfidence: 70, ...extra });
const mrNo  = (extra) => inp({ statAbove: false, statConfidence: 55, claudeAbove: false, claudeConfidence: 55, mlAbove: false, mlConfidence: 70, ...extra });
const mrYes = (extra) => inp({ statAbove: true,  statConfidence: 55, claudeAbove: true,  claudeConfidence: 55, mlAbove: true,  mlConfidence: 70, ...extra });
```
