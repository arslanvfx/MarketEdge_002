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

**How to apply:** Ranking is by **expected return** = `evMultiplier` desc (= jointTrueProb × payoutMultiplier = Π(trueProb/price)), tiebreak `jointTrueProb` desc. The per-risk probability floors (`minGeoMean^n`) keep the pool sane, so highest-EV (likely AND high-paying) combos surface first; ties favor the more likely/smaller combo. EV gate `evMultiplier < 1` dropped. **There is no probability-tier/`probBand` logic anymore** — it was removed (user asked for "highest probabilities WITH highest returns = best", which expected return captures directly).

## Every combo is single platform + single category (placeability)
`autoGenerateCombos` groups qualifying legs by `${platform}::${category}` and enumerates combos **strictly within one group** — a parlay must be placeable as ONE slip on ONE site, and platforms won't let you combine unrelated categories (e.g. a World Cup match + a presidential market). So a combo never mixes platforms OR categories. **Why:** users reported Smart Picks proposing unplaceable combos that mixed Kalshi+Polymarket and mixed categories (sports + politics). `category` is threaded onto each `ScoredLeg` from `market.category`.

## kalshi-only empty results are EXPECTED, not a bug
With `platform=kalshi`, generation can still return 0 combos. Two compounding causes: (1) the AI judges most kalshi markets fairly-priced/low-confidence so few legs qualify; (2) **single-category grouping** means a combo needs ≥minLegs *independent* qualifying legs *in one category* — and Kalshi's live pool is often dominated by mutually-correlated series (S&P/CPI price brackets = same event, championship outrights = mutually exclusive) that block each other. Independent **match** markets (e.g. "X vs Y Winner?" WC/NFL games, category Soccer/Football) DO combo — but they come and go with the live schedule. Returning 0 when only correlated markets are live is **correct** (the old cross-category combos it used to return were unplaceable). Don't loosen thresholds to force combos.

## Category-balanced candidate pool (route)
`combos.ts` builds the AI-analysis pool with `pickBalanced` (round-robin highest-volume across categories per platform), NOT pure top-by-volume. **Why:** bulk series (dozens of CPI thresholds, BTC levels, outrights) would otherwise fill the whole `POOL_CAP=48` with mutually-correlated legs and starve the independent match markets that actually combo. `both` = `pickBalanced(kalshi,24)+pickBalanced(polymarket,24)` + volume backfill.

## Each leg needs a `selection` label — title alone is ambiguous on Kalshi
A Kalshi head-to-head match is THREE separate contracts (Team A / Team B / Tie) that ALL share one title ("Senegal vs Iraq Winner?"); the side the YES contract pays on lives in the API's `yes_sub_title`. So showing only the title + "YES" tells the user nothing about which side to back. We thread `yes_sub_title` → `Market.yesSubtitle` → leg `selection` via `sideLabel(title, yesSubtitle, position)` in optimizer.ts: head-to-head ("vs" in title) → "<team> to win" / "Not <team>" (Tie verbatim), threshold/other Kalshi markets verbatim ("Above 3.75%" — do NOT append "to win"), Polymarket → "Yes"/"No". **Why:** a user got a 1818x combo from the tool but placed 4.53x on Kalshi — they picked the favorites because "YES" didn't say the optimizer had actually chosen the cheap underdog/tie side. The payout math (1/Πprice) was correct; the bet was just unlabeled.

## High payout ≠ wrong math — it's the cheap side the optimizer picked
EV ranking (max Π trueProb/price) systematically prefers the cheapest qualifying side per market (low price → high payout AND often high edge ratio), so favorites get passed over for underdogs/ties unless `riskLevel=conservative` (higher `safeMinTrue` floor favors high-probability sides). A surprising 1000x+ multiplier is usually the optimizer backing longshots, not a bug. Conservative risk is the lever to bias toward favorites.

## Kalshi fetch must be concurrency-bounded + retried, never cached partial
"No combos found" for a category that clearly has live markets (e.g. Soccer during the World Cup) is usually NOT a combo-logic bug — it's the market-data fetch silently dropping a whole series. Kalshi rate-limits aggressively: firing all ~18 seed series PLUS the discovery probes at once (wide Promise.allSettled) trips the limiter, the slow series times out, `fetchKalshiSeries` returns `[]`, and that incomplete snapshot gets cached for the 60s TTL → the category vanishes until the cache expires. **Why:** a user picked Kalshi+Soccer and got nothing while raw `KXWCGAME` had 100 open markets. **How to apply:** keep upstream fan-out bounded (`mapWithConcurrency`, limit ~6) in BOTH `fetchAllKalshiSeries` and the discovery-probe loop, and retry `fetchKalshiSeries` on 429/5xx/timeout (exp backoff) before giving up. The cold path is slow (~24–32s, dominated by one-time 24h-cached discovery) but reliability beats caching a soccer-less pool. Category filter in the smart-picks route is case-insensitive — keep it that way so a typed "soccer" matches "Soccer".

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
