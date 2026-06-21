---
name: Same-game combo architecture
description: How Kalshi same-game props are grouped and exposed as combos in Smart Picks
---
# Same-game combo architecture

## The rule
Kalshi groups a game's props across series (KXWCGAME, KXWCTOTAL, KXWCSPREAD, KXWCBTTS, KXWCCORNERS) sharing a date-coded event suffix like `26JUN21ESPKSA`. `gameKey` = that suffix, `eventTicker` = full event ticker.

## How to apply
- `markets.ts`: `kalshiGameKey(event_ticker, series_ticker)` → strips the series prefix and validates the suffix matches `/^\d{2}[A-Z]{3}\d{2}/`; null for outrights/futures.
- `optimizer.ts` `legCorrelation()`: `eventKey` blocks same market (e.g. two winner outcomes); `gameKey` allows same-game cross-prop; `isOutright = competition != null && gameKey == null` → outrights block with any sibling in their competition.
- `combos.ts`: after `pickBalanced()`, the same-game expansion block (`if (platform !== "polymarket")`) pulls prop siblings for every Kalshi game already in the pool, up to `EXPANDED_CAP = 90`.

**Why:** Without pulling prop siblings into the AI pool the optimizer never sees them, so same-game combos never get built even though Kalshi supports them natively.
