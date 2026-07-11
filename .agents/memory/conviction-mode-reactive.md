---
name: Conviction mode reactive architecture
description: How conviction mode works — pure price-triggered FOK, all model gates bypassed
---

## Rule
Conviction mode is pure reactive FOK. Entry fires when yesPrice ≥ lockPrice (YES) or yesPrice ≤ (1−lockPrice) (NO). Zero model signals involved.

## All gates that MUST be bypassed for conviction mode
These gates all check model signals (Claude/ML direction) which are irrelevant in conviction mode. Each one has `S.config.decisionMode !== "conviction"` guard:

1. **kalshi-bot-loop.ts — yes_quality_gate** (Claude/ML must agree with YES direction) — bypassed
2. **kalshi-bot-loop.ts — no_quality_gate** (Claude/ML must agree with NO direction) — bypassed
3. **kalshi-bot-loop.ts — reversing_caution** (trend stability penalty, -20pp) — bypassed
4. **kalshi-bot-loop.ts — position-relative NO gate** (live price vs strike + ML confirm) — bypassed
5. **kalshi-bot-tick.ts — noSignals safety abort** (`signalsTotal < 1`) — bypassed with `decisionMode !== "conviction"` check
6. **kalshi-bot-tick.ts — all-signals gate** — bypassed (done earlier)
7. **kalshi-bot-tick.ts — return floor gate** — bypassed (done earlier)
8. **kalshi-bot-tick.ts — orderLimitPrice cap** — uses 0.99/0.01 bounds not 1/minReturnMultiple
9. **kalshi-bot-loop.ts — all-three signal gate** — bypassed (done earlier)
10. **kalshi-bot-loop.ts — strike proximity guard** — bypassed (done earlier)
11. **kalshi-bot-loop.ts — candle momentum guard** — bypassed (done earlier)
12. **kalshi-bot-loop.ts — strike oscillation filter** — bypassed (done earlier)

## Root cause history
- shadow bets in DB (blocked_by=yes_quality_gate/no_quality_gate) = conviction firing correctly but model-direction gates blocking the real order
- signalsTotal=0 safety abort = completeness gate required ≥1 model signal, but conviction has 0 by design

## Why
Conviction mode uses price position as the SOLE signal. Model directions (Claude/ML agree/disagree) are meaningless — price at ≥88¢ or ≤12¢ IS the signal.

## How to apply
Any new gate added to the loop or tick that checks model signals must be wrapped with `if (S.config.decisionMode !== "conviction")`.
