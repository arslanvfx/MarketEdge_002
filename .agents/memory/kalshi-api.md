---
name: Kalshi API migration
description: Kalshi's trading API moved URLs and changed price field formats
---

# Kalshi API migration

**Rule:** Use `https://api.elections.kalshi.com/trade-api/v2/markets` — the old `trading-api.kalshi.com` redirects and doesn't serve JSON correctly.

**Why:** Kalshi migrated their general trading API to the elections subdomain. The old URL returns a plain-text redirect message instead of JSON, causing the fetch to silently return empty arrays.

**Price field changes:**
- Old: `yes_ask` / `yes_bid` in cents (0–100 range, e.g. `50` = 50%)
- New: `yes_ask_dollars` / `yes_bid_dollars` in dollar format (0–1 range, e.g. `"0.5000"` = 50%)
- Use `last_price_dollars` as primary price source; fall back to midpoint of ask/bid

**General fetch quirk:** Fetching without `series_ticker` returns only provisional MVE (Multi-Variate Event) combo markets with zero liquidity. Must fetch known series (KXBTC, KXETH, KXINX, KXFED, KXCPI, KXGDP, KXNBA, KXWCGAME, KXWCTOTAL) in parallel to get real markets.

**How to apply:** Any time Kalshi market data is fetched or the Kalshi integration is updated, use the elections subdomain and the `*_dollars` price fields.
