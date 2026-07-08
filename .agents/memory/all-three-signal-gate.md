---
name: All-three signal gate architecture
description: Bot may only bet when stat+Claude+ML are all non-null; all signals come from getLatestCoinSignals (crypto-signals.ts); no fallbacks anywhere
---

# All-three signal gate

**Rule:** The bot must NEVER enter a bet unless all three model signals (stat, Claude, ML) are non-null. If any is missing it waits and re-checks. The Crypto Predictor is the ONLY place signals are computed.

**Why:** User mandate — the predictor tool is the source of truth; the bot must read its directions+confidence, never assemble its own signals or fall back to alternates. Previous fallbacks (pipeline Claude call, analyzeCoin stat fallback, liveDirectionCache write-back) created divergence between what the predictor showed and what the bot bet on.

**How to apply:**
- `getLatestCoinSignals(sym)` in `crypto-signals.ts` is the single accessor: stat from predCache forward predictions (horizon closest to remaining minutes) vs Kalshi strike; Claude from tracker opening call + live re-check override; ML inference from the same predCache snapshot.
- Three enforcement layers, all must stay: pipeline callback gate (fires only when all three non-null, `prevAnyWasNull` re-check transition), tick live gate, and engine-level `statAbove === null || claudeAbove === null || mlAbove === null → SKIP`.
- predCache read has a 10-min freshness guard (`PRED_MAX_AGE_MS`) — stale snapshot nulls stat AND ML so the gate blocks rather than betting on stale output.
- Guard tests in `kalshi-bot-guards.test.ts` (noFallbacks/*) ban direct signal-source calls in pipeline/tick/engine — keep them green when refactoring.
- Consequences (intended): coins with autopilot off (claudeEnabled=false) never bet; a mid-window server restart loses the Claude opening call, so no bets until the next window when Claude fires again.
