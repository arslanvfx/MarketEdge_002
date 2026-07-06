---
name: ml_gate hard checkpoint
description: ml_gate mode must block bets when mlAbove is null — no silent bypass allowed
---

## Rule
In `ml_gate` decisionMode, `mlAbove === null` (ML model not ready) is a hard BLOCK — no bet fires. The check lives in the Phase 3 coin loop in `kalshi-bot-loop.ts`, immediately after the `hardModelCount` gate.

**Why:** When the server restarts and the DB is degraded, `initMLFromDB` fails and the ML backfill also fails (network errors). This leaves all coins with `mlAbove: null`. Before this fix, `null` was treated as "no objection" — bets fired with only Stat+Claude despite being in ml_gate mode. The mode name means nothing if null is silently allowed through.

**How to apply:**
- The checkpoint is a standalone `if (S.config.decisionMode === "ml_gate")` block after hardModelCount
- It checks `_mlGateSigs.mlAbove == null` (null or undefined)
- Emits SKIP with reason: `"ml_gate checkpoint: ML not ready — model must vote before any bet fires"`
- Logs `[kalshi-bot] ml_gate checkpoint BLOCKED — ML not ready for ${sym}` at INFO level
- **No parole override** — a null ML vote is a missing prerequisite, not a low-accuracy result

**Location:** `artifacts/api-server/src/lib/kalshi-bot-loop.ts` — Phase 3 loop, after the `hardModelCount` gate block.

**Not tested in engine-core unit tests** — the pure `computeCorePairDecision` function is decisionMode-agnostic; this gate is loop-level only.

## Companion fix: ML init startup retry
`initMLFromDB` can fail on boot if DB pool hasn't recovered from autoscale sleep. Without a retry it stays permanently uninitialized → ml_gate blocks all bets forever.

- `ml-store.ts` exports `wasMLInitSuccessful()` (flag set true at end of successful try block)
- `crypto-tracker.ts` `scheduleMLInitRetry(attempt)` fires when `wasMLInitSuccessful()` is false after first attempt
- Backoff: 5s → 15s → 30s → 60s → 120s → 5 min, max 8 attempts
- On retry success: calls `runMLBackfillIfNeeded(96)` so backfill also runs
- Tracker startup is NOT blocked — all retries via `setTimeout` (background)
