---
name: Commodity 15-min markets via Pyth
description: GOLD/SILVER/WTI Kalshi markets — data source routing, fail-closed rules, and why Pyth (not Coinbase/Yahoo) is the price source
---

# Commodity 15-min markets (GOLD / SILVER / WTI)

The market universe lives in a pure module (`market-defs.ts`, no imports) so
node --test can load it; `crypto-data.ts` / `crypto-kalshi.ts` re-export from it.
Commodity defs carry `category: "commodity"` and a `PYTH:`-prefixed product id;
all data fetchers route on that prefix.

**Why Pyth:** Kalshi settles KXGOLD15M/KXSILVER15M/KXWTI15M against Pyth
(settlement_sources "Pyth - Gold/Silver/WTI"), so execution-safety decisions
must use Kalshi's authenticated Pyth publications rather than unrelated
Coinbase/Yahoo movement. The authenticated Kalshi identities are
`Metal.XAU/USD`, `Metal.XAG/USD`, and `Commodities.Index.PYTHOIL/USD`.
External Hermes market-data routes may use a different WTI identity; never
substitute that identity for Kalshi's own execution-safety stream.

**How to apply:**
- Spot: Hermes v2 `/updates/price/latest` (feed id resolved once via
  `/v2/price_feeds?query=`, matched on exact `attributes.symbol`). A publish
  age > 60s throws — commodities trade with market closures (weekends,
  daily breaks), and a frozen price must never feed conviction ticks. The
  conviction poller treats a throw as a failed tick → direction guard fails
  closed (< 2 samples → no block/no entry).
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
  the Coinbase path).
- Benchmarks rate-limits aggressively ("too many requests") — keep the
  existing per-product candle caches in front of it; never poll it per-tick.

Commodity Kalshi tickers share the exact crypto format
(`KX<SYM>15M-YYMONDD-HHMM-MM`, EDT close time), verified live 2026-08-12
(`KXGOLD15M-26AUG121400-00`), so the deterministic ticker derivation in the
bot tick needs no special-casing.

Commodities are NOT in TRAINING_COINS — Claude opening calls are autopilot-
gated like any non-training coin; stat + ML run normally.
