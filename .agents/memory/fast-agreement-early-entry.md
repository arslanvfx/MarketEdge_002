---
name: Fast-agreement early entry
description: Why the bot must not wait for Claude in minutes 0-3; stat+ML agreement bypasses the Claude-pending guard and WM readiness wait
---

## Rule
When Stat and ML both have a direction, AGREE, and at least one is confident (≥60), the Claude-pending guard must NOT block entry. Predicate: `checkFastAgreementEntry` in `kalshi-bot-engine-core.ts` (pure, tested).

**Why:** Claude's extended-thinking call takes 30-120s after window-open prefetch. Two stacked latency gates (Claude-pending guard for first 3 min + stability wait up to 240s) locked the bot out of minutes 0-4. In trending windows, prices collapse to extremes (1-10¢/90-99¢) by minute 3-4, so every late entry failed the min-return gate — the root cause of ~4 bets/4h and ZERO NO bets ever (bearish windows decay NO price fastest).

## How to apply
- Fast-agreement predicate lives in engine-core (pure); engine.ts uses it before the Claude-pending guard and re-exports through the barrel.
- ML inference must run BEFORE the Claude-pending guard so mlAbove is populated when the predicate evaluates.
- `STABILITY_WAIT_MAX_S` = 90 (was 240) in kalshi-bot-state.ts.
- Minute-1 chain: WM not ready → peek makeBotDecision (fast agreement lets it return a BET) → WM caution bypass fires if conf ≥65 and signalsAgreeing ≥2 → normal gates (min-return, EV, quality) still apply.
- PATH A handles the Claude-null decision: ML leads, Stat is a +6pp validator.

## Traps
- Do NOT re-add any unconditional early-minutes SKIP tied to Claude availability — it silently recreates the zero-NO-bets bug.
- The pending snapshot must record real mlAbove/mlConfidence, not nulls, or skip records lie about why the bot didn't bet.
