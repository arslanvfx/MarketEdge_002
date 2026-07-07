---
name: Pipeline signal cascade bug
description: Root cause of bot dashboard showing opposite directions from Crypto Predictor page — wrong stat signal poisoned all three downstream models
---

# The cascade bug

## What was wrong
In `kalshi-bot-pipeline.ts` Step 2, `statAbove` was computed as:
```typescript
statAbove = livePrice >= kalshiTarget;  // WRONG
```
This is a raw snapshot of whether the current price happens to be above or below
the Kalshi strike at the exact moment the pipeline runs. It is NOT the stat model.

## Why this is catastrophic
The wrong `statAbove` then cascaded:
1. **Claude** received the wrong stat as context → biased Claude toward wrong direction
2. **ML features 14 & 15** are `statAbove` and `claudeAbove` → ML learned on correct
   values from predictor page but was being fed wrong values at inference time
3. All three models showed ↓↓ while predictor page (using real model) showed ↑↑

## The fix
Step 2: use `getStatWindowCall(sym)?.aboveKalshi` (reads historyStore, same source as predictor page).
Fallback to raw price comparison only when historyStore has no snap yet (T+0 race).

Step 3 (Claude): use `getTrackerWindowCall(sym)` first — this is the predictor page's
"auto-ran at window open" Claude call stored in historyStore. Falls back to fresh
`_callPipelineClaude` only when tracker call not ready yet.

**Why:** The predictor page models have been carefully calibrated. The bot was running
a parallel Claude call with bad stat context. Unifying the source ensures the bot always
acts on the same signals the predictor page displays.

## Timing note
At server startup (historyStore empty), `getStatWindowCall()` returns null → raw
fallback fires. Once the tracker makes its first snap (~T+30s into the window),
the real stat signal is used. Similarly, `getTrackerWindowCall()` returns null until
the predictor's opening Claude call completes → falls back to fresh pipeline call.
This means the FIRST pipeline run (at window open) may still use fallbacks, but
any recheck (~T+2.5min) will have the correct predictor-page values.
