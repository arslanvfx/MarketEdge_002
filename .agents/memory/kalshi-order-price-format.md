---
name: Kalshi order price format
description: Price field rules for Kalshi v2 orders and correct bet sizing using fill price not quote price
---

## Rules

**Price format:** Kalshi v2 POST /portfolio/events/orders requires the `price` field at 1-cent resolution — a 2-decimal string like `"0.69"`. Sending 4-decimal values (e.g. `"0.6944"`) produces `400 invalid_price`.

**Rounding direction in computeMarketableLimitPrice:**
- Bid (buy YES): `Math.floor(priceFrac * 100) / 100` — round down, never exceed the maxCost cap
- Ask (buy NO): `Math.ceil(priceFrac * 100) / 100` — round up, never fall below the price floor

**Bet sizing must use expectedFillPrice, not the raw yesPrice quote:**
- Raw quote e.g. 0.50 → buffer pushes fill to 0.65 → 4 contracts × $0.65 = $2.60 > $2 limit
- Fix: compute `expectedFillPrice = computeMarketableLimitPrice(bookSide, yesPrice, minReturnMultiple)` before sizing
- `contractCount = Math.floor(betSize / expectedFillPrice)` — floor, never round up
- `betAmount = contractCount × expectedFillPrice` so the safety guard sees the real expected cost

**Why:** The marketable-limit buffer (+0.15 for bids) is intentionally aggressive to guarantee fills. Sizing off the raw quote ignores this buffer and can overspend by 30%+ (e.g. $2 limit → $2.60 actual).

**How to apply:** Any time contract count is computed for a live order, use the marketable-limit price, not the yesPrice/sideCost quote.
