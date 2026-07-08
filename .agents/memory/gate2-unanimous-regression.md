---
name: Gate 2 unanimous bypass regression
description: stat_conf consistently 50–57%; STAT_REQUIRED_MIN_CONF=58 on unanimous path kills all bets; must stay bypassed for Path A
---

## The rule
Gate 2 per-signal confidence floors (stat≥58, claude≥62, ml≥60) must ONLY apply to non-unanimous paths (B/C/D). Path A (all three agree) must bypass Gate 2 entirely. Gate 4 (composite confidence ≥ config.minConfidence) is the correct backstop for Path A.

**Why:** The stat model's calibrated output range is 50–57%. Setting STAT_REQUIRED_MIN_CONF=58 makes it impossible for ANY unanimous bet to pass — stat never reaches 58. This was confirmed by querying production DB: every coin had stat_conf in 50–57% range across all windows. Zero bets placed.

**How to apply:** In `computeCorePairDecisionUngated` (kalshi-bot-engine-core.ts), the Gate 2 block must be wrapped with `if (!unanimousSignal)`. Do NOT add the stat/ML/Claude floors to the unanimous branch. The `if (confidence < inp.minConfidence)` check at the end of the function (Gate 4) handles the unanimous quality gate.

## Evidence
Production DB records (mode=paper, 07:00–07:15 windows):
- BTC: stat_conf=56–57, ml_conf=68–76
- ETH: stat_conf=52–55, ml_conf=65–78
- DOGE: stat_conf=54, ml_conf=56–58
- HYPE: stat_conf=52, ml_conf=62
- SOL: stat_conf=55, ml_conf=65–72
- XRP: stat_conf=50–52, ml_conf=50–58
- BNB: stat_conf=52–54, ml_conf=53–64

Every single coin fails STAT_REQUIRED_MIN_CONF=58. All bets silently skipped.

## Detection
Symptom: pipeline fires completion trigger with all three non-null, "evaluating entry" is logged, then 9+ seconds of silence. The SKIP path in the tick had NO logger.info (fixed: now logs "[kalshi-bot] SKIP decision" at info level with reasoning, confidence, and all signal values).

## Fix applied
Removed the `if (unanimousSignal) { mlConf check + statConf check }` block from `computeCorePairDecisionUngated`. The non-unanimous block (`if (!unanimousSignal) { ... }`) now handles B/C/D paths only.
