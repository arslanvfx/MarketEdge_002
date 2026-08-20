---
name: Scalper NO-bet sizing bug
description: costPerContract was inverted for NO bets, causing 9× over-sizing on NO scalps
---

# Scalper NO-bet sizing bug

## The rule
`eligibility.price` IS the ask price for the selected side in both cases:
- YES side: `eligibility.price = yesAsk` (what you pay per YES contract)
- NO side: `eligibility.price = noAsk = 1 - yesBid` (what you pay per NO contract)

So `costPerContract = eligibility.price` for BOTH sides. Do NOT do `1 - eligibility.price` for NO.

## Why
Original code did:
```js
const costPerContract = side === "yes" ? price : 1 - price;
```
For NO at 90¢: `costPerContract = 1 - 0.90 = 0.10` → `floor(100/0.10) = 1000` contracts × 90¢ actual cost = $900 spend against a $100 budget.

The `1 - price` expression gives the *complementary* side's price (i.e. the YES equivalent price for DB storage), NOT the cost per contract.

## How to apply
- `costPerContract` and `costPerContractScan` in `kalshi-high-value-scalper.ts` must both be `finalEligibility.price` (not ternary)
- `fillYesPrice` (for DB storage only) correctly stays as `side === "yes" ? price : 1 - price`
- `actualSpend = filledCount * (side === "yes" ? fillYesPrice : 1 - fillYesPrice)` is also correct because it chains back to `price` through the complement
