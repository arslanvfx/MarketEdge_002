---
name: Commodity 15-min markets via Pyth
description: Five Kalshi commodity markets — settlement identities, opening targets, live-data routing, and fail-closed rules
---

# Commodity 15-min markets

The supported commodity set is GOLD, SILVER, WTI, COPPER, and NATGAS.

**Rule:** Execution evidence must use the exact Pyth identity named by Kalshi:
GOLD=`Metal.XAU/USD`, SILVER=`Metal.XAG/USD`,
WTI=`Commodities.Index.PYTHOIL/USD`,
COPPER=`Commodities.Index.CU/USD`, and
NATGAS=`Commodities.Index.NATGAS/USD`. Copper's separate public
`COPPER/USD` feed is not interchangeable with Kalshi's `CU/USD` settlement
identity.

**Why:** These contracts resolve against Pyth. A correlated exchange quote or
similarly named public feed can move differently from the settlement source and
turn a safety check into false evidence.

**How to apply:**
- Prefer Kalshi's authenticated `pyth_value` websocket. Kalshi's configured
  websocket universe currently omits Copper and Natural Gas even though their
  contracts are live. For those two, use Kalshi's event live-data commodity
  timeseries, validating the exact asset and event ticker on every response.
- Scope live-data caches and coalesced requests by both product and event ticker;
  a fresh point from the prior 15-minute event cannot cross the boundary.
- General UI reads may accept evidence up to 60 seconds old. Execution reads
  require source publication age within 5 seconds. Missing, stale, future-dated,
  wrong-asset, or wrong-event evidence must throw so entry fails closed.
- New-style contracts may keep `floor_strike` absent/TBD. Their authoritative
  target is the Pyth one-minute candle closing at the traded window's open.
  Fetch that exact timestamp only; never substitute the last candle returned by
  a partial history response. If the exact candle is absent, target stays null
  and trading remains blocked.
- Candles: Pyth Benchmarks TradingView shim `/v1/shims/tradingview/history`
  (any range in one call — no Coinbase-style 300-candle pagination). Candle
  volume is always 0; vwap/volTilt/volumeDirectionBias already degrade to
  neutral at zero volume.
- Order book: none exists (oracle, not exchange) — return empty book, never
  throw; imbalance features go neutral.
- Smart Exit: source publication time governs freshness; immutable publication
  identity prevents repeated local reads from inventing movement; local receipt
  time may order distinct same-timestamp publications. Coinbase tape/L2 are not
  applicable and must stay absent, not neutral. A live exit still requires
  fresh authenticated Kalshi held-side depth covering the full position.
- Settlement fallback close price: route `fetchWindowClosePrice` by prefix to
  the Pyth 1-min candle for the window's last minute (same slot convention as
  the Coinbase path). This legacy settlement fallback is intentionally separate
  from strict live target derivation.
- Benchmarks rate-limits aggressively ("too many requests") — keep the
  existing per-product candle caches in front of it; never poll it per-tick.

**Rule:** Commodity event and market tickers use DST-aware New York close time,
not a fixed UTC offset.

**Why:** A hardcoded EDT offset is wrong during standard time and can select the
wrong event at a boundary.

**How to apply:** Build the event ticker as
`KX<SYM>15M-YYMONDDHHMM` and the market ticker with its minute suffix, using
`America/New_York` formatting.
