---
name: Kalshi eval settlement edge cases
description: How evalClosedBets handles at-strike closes, DB write failures, and the re-evaluate admin tool
---

## Kalshi settles strictly > strike (not >=)
Kalshi's CF Benchmarks RTI settles "above" as **strictly greater than** the strike price.
At exactly equal, Kalshi settles NO (below). Use `closePrice > strike` (strict) in evalClosedBets
when falling back to Coinbase candle prices — using `>=` incorrectly marks at-strike closes as
YES wins.

**Why:** Confirmed via Kalshi API (`result: "no"`) on a market where Coinbase candle returned
exactly the strike value. The `>=` comparison caused a correct NO-bet WIN to be stored as LOSS.

**How to apply:** In `kalshi-bot-eval.ts`, the Coinbase fallback path uses `>`. Leave the ML
model's `evalMLCorrect` (used for backtesting) unchanged — that function uses its own semantics.

## evalClosedBets per-row isolation
The eval loop wraps each row in its own try-catch. A DB write failure on row N logs a warning
and continues to N+1. The failed row keeps `evaluatedAt=NULL` and is retried on the next tick
(called every 5 seconds from runBotLoopTick).

**Why:** A single connection timeout used to abort the entire batch, leaving all remaining rows
permanently unresolved until the next window transition (up to 15 min).

## reEvaluateSettledBets admin endpoint
`POST /api/crypto/bot/re-evaluate-bets?since=<ISO>&limit=<N>` — re-checks already-evaluated
bets against Kalshi's authoritative RTI and corrects wrong outcomes. Params are **query string**
not body. Requires Clerk admin auth OR `X-Clear-Password` header. Button now in bot config UI.

**Why:** Bets evaluated via Coinbase candle fallback can differ from Kalshi RTI (different
price source, rounding). The re-evaluate job corrects these post-hoc using the ground truth.

## Resting GTC guard must not clear on failure
`convictionRestingFiredThisWindow` must stay set even when `placeOrder` throws. Clearing it
on failure causes an infinite retry loop every 5 seconds. If the request actually reached Kalshi
(response lost in transit), a retry creates a duplicate live GTC order.

**Why:** Clearing the guard was intended to allow one retry, but any persistent Kalshi API error
caused infinite re-attempts. Missing one window is safer than double-exposure.
