---
name: ml_gate mode architecture
description: How ml_gate decision mode works — engine path, Path B tiebreaking, loop checkpoint, and lastMLAboveCache lifecycle
---

## ml_gate engine path (kalshi-bot-engine.ts)

Calls `computeCorePairDecision` with real `mlAbove`/`mlConfidence` but `mlMinConfidence: 999`
to prevent ML from promoting itself to Path A (primary driver).

ML participates as:
- Path B tiebreaker (Claude+ML vs Stat, 2-of-3)
- Confidence modifier (dissent penalty / boost) in Path B/C
- Post-core veto: if ML opposes the agreed direction at ≥ mlVetoMinConfidence (57%) → SKIP

## Path B tiebreaker (kalshi-bot-engine-core.ts)

When Claude and Stat disagree:
- `mlAbove === null` → SKIP "no ML to arbitrate" (ML cache empty)
- `mlAbove !== claudeDir` → SKIP safety net (Claude-ML misalignment pre-check fires first)
- `mlAbove === claudeDir` → PROCEED at BASE_CONFIDENCE_HALF_PAIR (Claude+ML 2-of-3 override Stat)

Note: the Claude-ML misalignment check (lines ~238-243 in engine-core.ts) fires BEFORE
Path B, so if ML disagrees with Claude the bet is already blocked before tiebreaker logic.

## lastMLAboveCache lifecycle

- Set in `crypto-tracker.ts` snap loop at window-open snap AND mid-window re-snap (T+7 min)
- Also set by live Claude re-check in `crypto-claude.ts`
- Empty after server restart — cache is in-memory only
- "No ML to arbitrate" appears after restart until the first snap runs (window open or T+7)

## ml_gate loop checkpoint (kalshi-bot-loop.ts)

After `makeBotDecision()`, Phase 3 loop has a hard gate:
- `decisionMode === "ml_gate"` AND `decision.signals.mlAbove == null` → BLOCK with own reason
- `decision.signals.mlAbove` comes from `buildSnapshot()` which captures `mlAbove` from the OUTER closure (real value)
- No parole override for this checkpoint

**Why:** buildSnapshot in engine.ts captures statAbove/claudeAbove/mlAbove from the outer
function closure, not from the inner computeCorePairDecision call. This is intentional —
the signals snapshot shows the real values even in modes where they're withheld from core.

## Companion fix: ML init startup retry

`initMLFromDB` can fail on boot if DB pool hasn't recovered. Without a retry it stays
permanently uninitialized → ml_gate blocks all bets forever.

- `ml-store.ts` exports `wasMLInitSuccessful()` (flag set true at end of successful try block)
- Retry is triggered via `onMLRetrySuccess` callback (passed to `startPredictionTracker`)
- `index.ts` passes `() => runMLBackfillIfNeeded(96)` as the callback
- **Never import `runMLBackfillIfNeeded` directly in `crypto-tracker.ts`** — creates circular dep:
  `crypto-tracker.ts → ml-backfill.ts → crypto.ts → crypto-tracker.ts`
