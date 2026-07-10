---
name: Conviction mode — pure reactive FOK
description: Conviction mode fires a reactive FOK based solely on Kalshi contract price; no GTC orders, no model veto, no pre-entry zone
---

## Rule
Conviction mode is purely reactive: fire a FOK order immediately when
- `yesPrice >= lockPrice` → BET_YES
- `yesPrice <= (1 - lockPrice)` → BET_NO
- otherwise → SKIP

No RESTING_LIMIT, no pre-entry zone, no model veto, no upper band.

**Why:** GTC resting orders and model vetoes caused missed bets when price crossed lockPrice during the ~5s between ticks or when all three models happened to oppose. The original pre-GTC behavior placed bets consistently. Removing GTC also eliminates order-tracking complexity (restingOrders Map, poll loop, cancel retries, duplicate-exposure guards).

**How to apply:**
- `ConvictionInputs` has only `yesPrice`, `lockPrice`, `minConfidence` — no model signals
- `BotDecisionAction` has NO `RESTING_LIMIT` variant — any reference is a bug
- `convictionFiredThisWindow` Set still exists (prevents same-window double-bets on price oscillation)
- `convictionRestingFiredThisWindow` and `restingOrders` are GONE — do not re-add
- GTC UI controls (pre-entry slider, GTC time-gate slider, resting toggle) are GONE from bot-config-section.tsx
- Conviction preset in routes/kalshi-bot.ts has NO `preConvictionThreshold`/`useRestingLimitOrders`/`convictionRestingWindowMinutes`
