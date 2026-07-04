---
name: Kalshi order price format and bet sizing
description: Price field rules for Kalshi v2 orders and correct bet sizing — YES and NO have asymmetric cost mechanics
---

## Price format

Kalshi v2 POST /portfolio/events/orders requires `price` at 1-cent resolution — a 2-decimal string like `"0.69"`. Sending 4-decimal values (e.g. `"0.6944"`) produces `400 invalid_price`.

Rounding direction in computeMarketableLimitPrice:
- Bid (buy YES): `Math.floor(priceFrac * 100) / 100` — round down, never exceed maxCost cap
- Ask (buy NO): `Math.ceil(priceFrac * 100) / 100` — round up, never fall below price floor

## Bet sizing — YES vs NO are ASYMMETRIC

For a YES buy (bid):
- We pay the **bid price** we submit (fill can only improve).
- Worst-case cost = `computeMarketableLimitPrice("bid", yesPrice, minReturnMultiple)`
- e.g. yesPrice=0.50, bid=0.65 → cost ≤ 0.65 per contract

For a NO buy (ask):
- We submit a LOW ask to cross the YES bid, but the fill happens at the **resting YES bid**.
- Our actual NO cost = `1 − YES_fill ≈ 1 − yesPrice = sideCost`
- The ask price we submit does NOT determine our cost — it only ensures we cross the spread.
- Using `computeMarketableLimitPrice("ask", yesPrice)` here returns ~0.22 (the low ask), which massively OVERESTIMATES contract count and blows past budget.

## Correct sizing code (kalshi-bot.ts)

```typescript
const sideCost = direction === "yes" ? (yesPrice ?? 0.5) : (1 - (yesPrice ?? 0.5));
const expectedFillCost =
  direction === "yes"
    ? computeMarketableLimitPrice("bid", yesPrice, config.minReturnMultiple)
    : sideCost; // NO cost ≈ 1 − yesPrice
const contractCount = Math.max(1, Math.floor(config.betSize / expectedFillCost)); // floor, never round up
const betAmount = contractCount * expectedFillCost;
```

**Why:** Math.floor guarantees budget is never exceeded. sideCost for NO is the right proxy for actual fill cost because YES fill price ≈ quoted yesPrice.

**How to apply:** Any future change to contract sizing must respect this YES/NO asymmetry. Never use computeMarketableLimitPrice("ask", ...) for NO bet sizing.
