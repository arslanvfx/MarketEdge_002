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

## Correlation guard — never parlay correlated legs
`autoGenerateCombos` rejects a combo if any two legs are correlated (see `legsAreCorrelated` / `legCorrelation` in `optimizer.ts`). A combo is rejected when:
1. Two legs share an **event** (both sides of one match, or two outcomes of one mutually-exclusive race). Kalshi tickers are `<series>-<event>-<outcome>`; dropping the last segment yields the event key. Polymarket has no event grouping in our data, so each market stands alone.
2. Two legs share a **competition** and at least one is NOT an independent match — an outright winner ("Will Morocco win the 2026 World Cup?") correlates with every game and with other teams' outrights; threshold markets (two S&P/CPI levels, same Kalshi series) move together. **Two DIFFERENT matches of the same competition ARE allowed** (normal multi-game sports parlay).
3. Two legs share a title **family** (same market, different threshold).

Competition is derived from title patterns (`COMPETITION_TITLE_PATTERNS` — the cross-platform bridge, e.g. Polymarket WC outright ↔ Kalshi WC match both map to `fifa-world-cup`) and, for Kalshi, the ticker series prefix (`kalshiCompetitionGroup`). `isMatch` = title contains "vs"/"versus".

**Why:** Users reported Smart Picks proposing combos that can't be placed on the platform (e.g. a World Cup match + "Will Morocco win the World Cup?", or two mutually-exclusive "Will X win the Cup?" outrights). Those legs are correlated, so multiplying their probabilities as independent is also statistically invalid. The old guard only used `marketFamilyKey`, which caught same-market-different-threshold but missed cross-platform same-tournament and mutually-exclusive outrights (different team names → different family keys).

**How to apply:** When adding a competition that has both outright winners AND individual games (so titles differ but they're correlated), add a `COMPETITION_TITLE_PATTERNS` entry and/or a `kalshiCompetitionGroup` prefix mapping. Test independent-match parlays still pass while outright+match is rejected.

## Categories
`listCategories` returns `{name, count, volume}` sorted by volume desc. `kalshiCategory` maps Kalshi series prefixes to specific sports (Basketball/Baseball/Football/Hockey/Soccer/Golf/Motorsport/Tennis/Combat Sports/Cricket) instead of a generic "Sports". Frontend uses top-N by volume as trending chips + a searchable combobox over all categories.
