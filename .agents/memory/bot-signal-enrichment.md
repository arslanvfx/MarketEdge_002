---
name: Bot signal enrichment
description: What fields are stored in the enrichedSignals JSON on every placed bet, and how to extend it.
---

## Fields in enrichedSignals (as of 2026-07-03)
Built in `_runBotTick` just before `persistBetRecord`:
```
decision.signals (SignalSnapshot spread):
  statAbove, claudeAbove, mlAbove
  statConfidence, claudeConfidence, mlConfidence
  signalsAgreeing, signalsTotal, agreementTarget
  windowMonitor, windowMonitorReady, signalAccuracyPct
  minutesElapsed, warmupActive, ev, roiPct, yesPrice

Enriched additions:
  effectiveConfidence   — Phase-3 penalized confidence (not raw decision.confidence)
  regime                — "above"|"below"|"neutral"|null from regimeCache (module-level)
  trendStability        — "clean"|"choppy"|"reversing"|null from windowStabilityCache (module-level)
  windowDoubtPenalty    — 0|4|8 from currentWindowDoubtPenalty (module-level, set in Phase 3)
```

## How to add more fields
`regimeCache` and `windowStabilityCache` are module-level Maps — accessible directly in `_runBotTick`.
For Phase-3-only values (like doubt penalty), use a module-level variable set in `runBotWindow` and read in `_runBotTick`.

## Config snapshot location
Pre-Task-A/B/C config: `.local/config-snapshots/pre-task-abc-2026-07-03.json`
Contains production config values and `analysis_context` explaining why changes were made.
