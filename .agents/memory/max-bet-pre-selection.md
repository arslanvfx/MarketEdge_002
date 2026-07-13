---
name: Max-bet pre-selection
description: How the best stable coin is chosen deterministically for the per-window max-bet token
---

# Max-bet pre-selection (deterministic winner)

## The rule
Before `Promise.allSettled(betSymbols.map(runCoin))` in conviction mode, the loop pre-scores
all coins and stores the winner in `maxBetCandidateForWindow: Map<windowKey, sym | null>`
(exported from `kalshi-bot-state.ts`).  Only the pre-selected coin can claim the global
`maxBetWindowToken`; all other stable coins fall through to regular bet size.

## Why
`Promise.allSettled` runs coins in parallel — whichever async tick reached the token claim
first won, non-deterministically.  With pre-selection the highest-ER stable coin wins every
time regardless of scheduling order.

## How to apply
- Pre-selection guard lives in `kalshi-bot-tick.ts` boostBetSize IIFE, stable path, right
  before the `maxBetWindowToken.remaining <= 0` token check.
- Pre-selection scoring runs in `kalshi-bot-loop.ts` before the parallel dispatch block, only
  when `_isConvictionMode && convictionStabilityEnabled !== false && token.remaining > 0`.
- Score formula: `ER×100 − osc×1.5 + (mlConf??minMLConf)×0.3 − vol×10` (ER is primary).
- Map cleared at window transition alongside `coinStabilityCache.clear()`.
- When `bestSym === null` (no coin passes thresholds), no coin can claim max bet.
- Map re-evaluated every tick so the winner always uses the freshest indicator data.
