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

## Prop series must be in the hardcoded seed list for reliable same-game combos
The auto-discovery mechanism (pages /events?status=open) has a 24h TTL cache — on first boot, prop series like KXWCSPREAD/KXWCBTTS/KXWCCORNERS/KXNBASPREAD/KXNBATOTAL will be missing until discovery runs. Add them explicitly to `KALSHI_SERIES` so they're fetched unconditionally. `fetchKalshiSeries` returns [] silently if a ticker has no open markets, so listing a non-existent series causes no harm.

**How to apply:** Whenever a new sport or prop category launches on Kalshi, add all its prop series (winner, spread, total, BTTS, corners, player props) to the hardcoded list alongside the main series. Don't rely on discovery alone for series needed for same-game combos.

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

## AI prompt must include yesSubtitle — the YES-side identity bug
The analyzeMarkets prompt MUST include `[YES = "<yesSubtitle>"]` on every market line. Without it, Claude infers which side YES pays on from the title alone and gets it wrong for winner markets: seeing "France vs Iraq Winner?" at 4%, Claude estimates France's probability (82%) but assigns it to the Iraq YES contract — creating a massive false edge (+78 pts) and surfacing Iraq as a "value" bet. The explicit label ("France vs Iraq Winner?" [YES = "Iraq"]) plus a rule in the prompt ("estimate the probability of THAT specific outcome") prevents this. The 30-min analysis cache persists stale wrong values — server restart is needed after prompt changes.

**How to apply:** Any time yesSubtitle is available, include it in the market line. For markets without a subtitle (some Polymarket markets), omit it; Claude uses the title alone, which is usually unambiguous for yes/no questions.

## Lottery combo guard — two floors needed, not one
The geometric floor `minGeoMean^n` alone cannot prevent many-leg lottery combos because it approaches 0 as n grows. An 8-leg combo at aggressive minGeoMean 0.39 needs only 0.39^8 ≈ 0.01% joint probability — essentially unconstrained. Two additional guards are needed:
- **maxAutoLegs** (per risk level): hard cap on leg count when legCount="auto" (conservative: 3, balanced: 4, aggressive: 4). Users who explicitly set a leg count consciously accept larger combos.
- **minJointProb** (per risk level): absolute floor on the full parlay's win probability (conservative: 25%, balanced: 12%, aggressive: 6%). Applied after the geometric floor check in the enumeration loop.

**How to apply:** Add both fields to RISK_TUNING whenever changing risk parameters. The cap is on auto-mode only (`legCount === "auto" ? maxAutoLegs : pool.length`).

## Correlation guard + SAME-GAME combos (Kalshi native-combo parity)
`autoGenerateCombos` controls which legs may parlay together via `legsAreCorrelated` / `legCorrelation` in `optimizer.ts`. The model has THREE grouping levels for a Kalshi market, derived from its `event_ticker`:
- **eventTicker** = the underlying market (every YES/NO outcome and every threshold of one contract share it). Two legs with the same eventTicker are ALWAYS blocked (both sides of one match, two rungs of one ladder).
- **gameKey** = the physical GAME, shared by all of a game's prop markets (winner KXWCGAME, total KXWCTOTAL, spread KXWCSPREAD, BTTS, corners, player props). Derived by stripping the series prefix from event_ticker and keeping only dated games matching `/^\d{2}[A-Z]{3}\d{2}/`. Outrights/futures have NO gameKey.
- **competition** = the tournament (from `COMPETITION_TITLE_PATTERNS` + `kalshiCompetitionGroup` prefix).

A combo is rejected when: (1) two legs share an eventTicker; (2) an **outright** (`isOutright = competition != null && gameKey == null`, e.g. "Will Brazil win the World Cup?") shares a competition with ANY other leg — outrights correlate with every game and every other team's outright; (3) two NON-game markets share a title family/competition (threshold ladders like S&P/CPI move together). The family guard is applied ONLY to markets without a gameKey.

**What is now ALLOWED (the headline change):** multiple PROP markets of the SAME game (winner + total + spread + …, different eventTickers, one gameKey) — this is a same-game combo, mirroring Kalshi's native combo builder. Also still allowed: two DIFFERENT games of one competition (ordinary multi-game parlay).

**Why:** Users wanted Kalshi same-game prop combos. The previous guard blocked everything sharing a competition unless it was a "vs"-titled match, which prevented winner+total+spread of one game from ever combining. The new gameKey concept lets game props combine while still blocking the genuinely-correlated outrights and threshold ladders.

**Caveat (statistical):** same-game prop legs ARE positively correlated, so our independent-leg probability/payout math is an approximation — combos carrying a same-game subset get a rationale note saying so (Kalshi prices the real parlay). `eventTicker`/`gameKey` are surfaced on each output leg so the UI/tests can detect grouping.

**How to apply:** A new sport works automatically IF its Kalshi event_ticker dated suffix matches the gameKey regex AND its prop series are fetched. When adding a competition with both outrights AND games, add a `COMPETITION_TITLE_PATTERNS` / `kalshiCompetitionGroup` mapping so outright-vs-game is still rejected. Live same-game combos are AI/edge-gated and come and go with the schedule — empty live results are not proof the logic is broken; verify the logic with a synthetic optimizer harness instead (Node 24 `node --experimental-strip-types` can import optimizer.ts directly since its Market import is type-only).

## Polymarket = single best bets, never parlays
Polymarket groups in `autoGenerateCombos` are forced to size 1 (`groupMin/groupMax = 1`) → each surfaces as a standalone single bet. `combos.ts` sibling-expansion is Kalshi-only. Frontend labels 1-leg results "Single bet N". **Why:** Polymarket markets lack the event/game grouping metadata Kalshi has, and the product decision is Polymarket → best singles, Kalshi → same-game combos.

## Categories
`listCategories` returns `{name, count, volume}` sorted by volume desc. `kalshiCategory` maps Kalshi series prefixes to specific sports (Basketball/Baseball/Football/Hockey/Soccer/Golf/Motorsport/Tennis/Combat Sports/Cricket) instead of a generic "Sports". Frontend uses top-N by volume as trending chips + a searchable combobox over all categories.
