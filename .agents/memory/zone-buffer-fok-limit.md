---
name: Zone buffer vs FOK limit price
description: capBuffer/floorBuffer must only relax the pre-order trigger check; the actual FOK limit must stay pinned to strict lockPriceCap — using absoluteMax as the limit cap causes fills above the zone and immediate emergency closes.
---

# Zone Buffer vs FOK Limit Price

## The Rule
`capBuffer` and `floorBuffer` (convictionZoneFloorBuffer / convictionZoneCapBuffer) expand `absoluteMin`/`absoluteMax` — the gate that decides **whether to attempt** an order. They must NEVER be used as the FOK limit price.

The FOK limit price must always be:
- YES orders: `min(freshYesAsk, lockPriceCap)`
- NO orders:  `max(freshYesBid, 1 - lockPriceCap)`

**Why:** The post-fill emergency close uses the strict `[lockPrice, lockPriceCap]` zone. If the FOK limit uses `absoluteMax = lockPriceCap + capBuffer`, Kalshi can fill at e.g. 88¢ when lockPriceCap=86¢ → fillDeviation > 0 → immediate emergency close + sell at a loss.

**How to apply:** Any time you touch the order submission block in `kalshi-bot-tick.ts` (around `orderLimitPrice =`), the cap must be `lockPriceCap`, not `absoluteMax`.

## Additional note on capBuffer uselessness
After pinning the FOK limit to lockPriceCap, `capBuffer` is effectively a wasted-attempt generator: when price is in `(lockPriceCap, absoluteMax]`, the bot tries a FOK at lockPriceCap which Kalshi rejects immediately (no one sells YES to you below market). Each rejection burns a `windowFailedFills` slot. Default capBuffer should be 0.

`floorBuffer` remains useful: when price is in `[absoluteMin, lockPrice)`, the bot tries at lockPriceCap and Kalshi can price-improve downward into the zone.
