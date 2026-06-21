---
name: Polymarket single-bet mode
description: Why Polymarket always emits size-1 results in Smart Picks
---
# Polymarket single-bet mode

## The rule
`forceSingle = isPolymarket || legCount === 1 || isKalshiNonSport`

## Why
Polymarket's Gamma feed exposes no event grouping or combo pricing. Parlaying Gamma markets means multiplying probabilities as if independent — they're not, and the platform has no single combo slip. So we surface each Polymarket group as its single best bet.

Kalshi non-sport categories (Economics, Crypto, Stocks, Politics, etc.) are also single-only because Kalshi's own combo builder only covers sports.

## How to apply
This is set in `optimizer.ts` `autoGenerateCombos()` per group. `groupMin/groupMax` are both 1 when `forceSingle`.
