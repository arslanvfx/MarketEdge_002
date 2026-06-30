---
name: Self-learning analytics architecture
description: How effectiveConfidence, confidence-band breakdown, and data-driven auto-tuning are wired together.
---

## The rule
Every bet record now stores `effectiveConfidence` (the composite decision score) in its signals JSONB. The analytics engine uses this to build per-confidence-band win rates and derive the data-validated optimal threshold for auto-tuning.

**Why:** Without the actual gate score persisted, analytics had to proxy from `statConfidence` (one model's view, not the composite). Bands based on proxy confidence were inaccurate, making data-driven threshold tuning unreliable.

## How to apply

**Signal enrichment (kalshi-bot.ts, bet placement):**
```typescript
const enrichedSignals = {
  ...(decision.signals as Record<string, unknown>),
  effectiveConfidence: decision.confidence,
};
// use enrichedSignals in persistBetRecord, NOT decision.signals
```

**Analytics (kalshi-bot-performance.ts):**
- `extractEffectiveConfidence()` — prefers `signals.effectiveConfidence`, falls back to `statConfidence`/`claudeConfidence`/`confidence` for historical bets
- `byConfidenceBand` — 6 bands: 50-55, 55-60, 60-65, 65-70, 70-75, 75+; needs ≥5 samples per band to be reliable
- `byAgreementLevel` — keyed by `"${signalsAgreeing}/${signalsTotal}"`; extracted from signals JSONB
- `optimalConfidenceThreshold` — lowest band lowerBound where betCount≥5 AND winRate≥55%

**Auto-tune Rule 3 (data-driven vs blind):**
- If `optimalConfidenceThreshold` exists and > current floor → jump directly to it
- Otherwise → blind +5 fallback
- Trigger reason in log distinguishes which path fired
- Same 6-hour cooldown as before; shared ruleName `"confidence_floor_raise"`

**Dashboard (bot-dashboard.tsx):**
- "Win Rate by Confidence Level" — horizontal bar chart per band, starred optimal, green/yellow/red color
- "Win Rate by Signal Agreement" — 3-column grid of agreement level cards
- Both panels are conditional (only render when ≥1 band/level has data)
