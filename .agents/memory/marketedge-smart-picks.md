---
name: MarketEdge Smart Picks optimizer
description: How the Smart Picks parlay generator gates legs (value vs safe), sizes combos, and why kalshi-only can return empty.
---

# Smart Picks combo generation

## Two leg classes: value + safe
Each combo leg is classified `legType: "value" | "safe"` (see `optimizer.ts`).
- **value** = genuinely mispriced: `edge >= EDGE_THRESHOLD (0.05)` AND `trueProb >= minLegTrue`.
- **safe** = confident favorite, not value: `edge >= 0` AND `trueProb >= safeMinTrue` AND `confidence !== "low"`.
- Per market, one best side is chosen; value always beats safe; within a class the stronger leg wins (value→bigger edge, safe→higher prob).

**Why:** Pure-value pools were too thin — picking a platform + a high leg count often yielded 0 combos because only ~2 value legs existed. Adding safe favorites (user-approved "value + safe favorites" direction) broadens the pool so multi-leg combos can form, while each leg is labelled so users see which is which.

Risk tuning (`RISK_TUNING` in optimizer): conservative `safeMinTrue 0.8`, balanced `0.7`, aggressive `0.6`.

## legCount is a MINIMUM, not exact
`legCount` ("auto"|2|3|4|5) means "this many legs or more". `"auto"` = 2+. The optimizer enumerates sizes from `minLegs` up to `min(pool, TOP_LEGS_CAP=16)` — there is NO 4-leg cap. `"5"` allows large combos (up to the cap).

**How to apply:** Ranking is probability-tier-first (`tierOf(jointTrueProb)` by `probBand`), then value-count desc, then payout multiplier — so the safest combo surfaces first but fewest-leg / highest-value is preferred at comparable odds. EV gate is `evMultiplier < 1` dropped (every leg has edge>=0 so multiplier>=1 is guaranteed).

## kalshi-only empty results are EXPECTED, not a bug
With `platform=kalshi`, generation can still return 0 combos even at min2. Cause: the AI judges most kalshi markets as fairly-priced (no edge) or below `safeMinTrue` / low-confidence, so <2 legs qualify. The route DOES analyze up to `POOL_CAP=48` kalshi markets — pool size is not the limiter; the quality gate is. `both` platforms generates fine. Don't "fix" this by loosening thresholds without a reason.

## Result field name
The combo's win probability field is `jointProbability` (NOT `combinedProbability`). Reading the wrong name yields NaN.

## Categories
`listCategories` returns `{name, count, volume}` sorted by volume desc. `kalshiCategory` maps Kalshi series prefixes to specific sports (Basketball/Baseball/Football/Hockey/Soccer/Golf/Motorsport/Tennis/Combat Sports/Cricket) instead of a generic "Sports". Frontend uses top-N by volume as trending chips + a searchable combobox over all categories.
