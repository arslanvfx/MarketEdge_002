// ---------------------------------------------------------------------------
// market-defs.ts — pure market definitions (no imports, unit-testable)
//
// Single source of truth for the 15-min Kalshi market universe: crypto coins
// (Coinbase products) and commodities (Pyth-sourced products).  Kept free of
// any imports so node --test can load it directly (see api-server-unit-tests
// pattern: pure logic lives outside db/logger-importing modules).
// ---------------------------------------------------------------------------

export interface CoinDef {
  symbol: string;
  product: string;
  name: string;
  /** Market category — "crypto" (default) trades on Coinbase products;
   *  "commodity" trades on Pyth-sourced spot feeds (product = "PYTH:<pyth symbol>"). */
  category?: "crypto" | "commodity";
}

export interface PythFeedDef {
  product: string;
  symbol: string;
  feedId: string;
}

export interface CfBenchmarksFeedDef {
  product: string;
  /** Identifier printed in the Kalshi market's settlement rules. */
  indexId: string;
  /** Identifier used by Kalshi's cfbenchmarks_value websocket channel. */
  streamIndexId: string;
}

/** Exact RTI identities named in each Kalshi 15-minute crypto market's rules. */
export const CF_BENCHMARKS_CRYPTO_FEEDS: Record<string, CfBenchmarksFeedDef> = {
  BTC:  { product: "BTC-USD",  indexId: "BRTI",       streamIndexId: "BRTI" },
  ETH:  { product: "ETH-USD",  indexId: "ETHUSDRTI",  streamIndexId: "ETHUSD_RTI" },
  SOL:  { product: "SOL-USD",  indexId: "SOLUSDRTI",  streamIndexId: "SOLUSD_RTI" },
  XRP:  { product: "XRP-USD",  indexId: "XRPUSDRTI",  streamIndexId: "XRPUSD_RTI" },
  HYPE: { product: "HYPE-USD", indexId: "HYPEUSDRTI", streamIndexId: "HYPEUSD_RTI" },
  BNB:  { product: "BNB-USD",  indexId: "BNBUSDRTI",  streamIndexId: "BNBUSD_RTI" },
  DOGE: { product: "DOGE-USD", indexId: "DOGEUSDRTI", streamIndexId: "DOGEUSD_RTI" },
  NEAR: { product: "NEAR-USD", indexId: "NEARUSDRTI", streamIndexId: "NEARUSD_RTI" },
  ZEC:  { product: "ZEC-USD",  indexId: "ZECUSDRTI",  streamIndexId: "ZECUSD_RTI" },
};

/**
 * Canonical Pyth Core feed identities used by Kalshi's commodity contracts.
 * Keep these explicit: execution must not depend on a best-effort feed search
 * during process startup.
 */
export const PYTH_COMMODITY_FEEDS: Record<
  "GOLD" | "SILVER" | "WTI" | "COPPER" | "NATGAS",
  PythFeedDef
> = {
  GOLD: {
    product: "PYTH:Metal.XAU/USD",
    symbol: "Metal.XAU/USD",
    feedId: "765d2ba906dbc32ca17cc11f5310a89e9ee1f6420508c63861f2f8ba4ee34bb2",
  },
  SILVER: {
    product: "PYTH:Metal.XAG/USD",
    symbol: "Metal.XAG/USD",
    feedId: "f2fb02c32b055c805e7238d628e5e9dadef274376114eb1f012337cabe93871e",
  },
  WTI: {
    product: "PYTH:Commodities.Index.PYTHOIL/USD",
    symbol: "Commodities.Index.PYTHOIL/USD",
    feedId: "67784f72e95ac01337edb7d7bd5bbd1c03669101b7068a620df228ed4e52ef14",
  },
  COPPER: {
    product: "PYTH:Commodities.Index.CU/USD",
    symbol: "Commodities.Index.CU/USD",
    feedId: "b2b238aeb6ef5a722c5cf278595bf40434e174cac4f88c8ad5b6f5009b548c59",
  },
  NATGAS: {
    product: "PYTH:Commodities.Index.NATGAS/USD",
    symbol: "Commodities.Index.NATGAS/USD",
    feedId: "45f95717fbe158e896415d1cea33814d73e54169022a8f7bcbb815ebef92f71c",
  },
};

export const CRYPTO_COINS: CoinDef[] = [
  { symbol: "BTC",  product: "BTC-USD",  name: "Bitcoin" },
  { symbol: "ETH",  product: "ETH-USD",  name: "Ethereum" },
  { symbol: "SOL",  product: "SOL-USD",  name: "Solana" },
  { symbol: "XRP",  product: "XRP-USD",  name: "XRP" },
  { symbol: "HYPE", product: "HYPE-USD", name: "Hyperliquid" },
  { symbol: "BNB",  product: "BNB-USD",  name: "BNB" },
  { symbol: "DOGE", product: "DOGE-USD", name: "Dogecoin" },
  { symbol: "NEAR", product: "NEAR-USD", name: "NEAR Protocol" },
  { symbol: "ZEC",  product: "ZEC-USD",  name: "Zcash" },
  // ── Commodities (Kalshi 15-minute markets settling against Pyth) ───────────
  // Live spot + candles come from Pyth — the SAME oracle Kalshi settles these
  // markets against (settlement_sources: "Pyth - Gold/Silver/WTI").  Product
  // ids use the "PYTH:" prefix; crypto-data.ts fetch helpers route on it.
  { symbol: "GOLD",   product: PYTH_COMMODITY_FEEDS.GOLD.product,   name: "Gold",      category: "commodity" },
  { symbol: "SILVER", product: PYTH_COMMODITY_FEEDS.SILVER.product, name: "Silver",    category: "commodity" },
  { symbol: "WTI",    product: PYTH_COMMODITY_FEEDS.WTI.product,    name: "WTI Crude", category: "commodity" },
  { symbol: "COPPER", product: PYTH_COMMODITY_FEEDS.COPPER.product, name: "Copper",    category: "commodity" },
  { symbol: "NATGAS", product: PYTH_COMMODITY_FEEDS.NATGAS.product, name: "Natural Gas", category: "commodity" },
];

/** Symbols in the commodity category (derived — single source of truth is CRYPTO_COINS). */
export const COMMODITY_SYMBOLS: string[] = CRYPTO_COINS
  .filter((c) => c.category === "commodity")
  .map((c) => c.symbol);

export function isPythProduct(product: string): boolean {
  return product.startsWith("PYTH:");
}

// Kalshi 15-minute series tickers, keyed by market symbol.
// Commodity series verified live 2026-08-12 (e.g. KXGOLD15M-26AUG121400-00);
// they settle against Pyth and share the crypto cadence + ticker format.
export const KALSHI_SERIES: Record<string, string> = {
  BTC:  "KXBTC15M",
  ETH:  "KXETH15M",
  SOL:  "KXSOL15M",
  XRP:  "KXXRP15M",
  HYPE: "KXHYPE15M",
  BNB:  "KXBNB15M",
  DOGE: "KXDOGE15M",
  NEAR: "KXNEAR15M",
  ZEC:  "KXZEC15M",
  GOLD:   "KXGOLD15M",
  SILVER: "KXSILVER15M",
  WTI:    "KXWTI15M",
  COPPER: "KXCOPPER15M",
  NATGAS: "KXNATGAS15M",
};

/** Build the current 15-minute event ticker using Kalshi's New York close-time format. */
export function computeCurrentKalshiEventTicker(
  symbol: string,
  nowMs = Date.now(),
): string | null {
  const series = KALSHI_SERIES[symbol.toUpperCase()];
  if (!series || !Number.isFinite(nowMs)) return null;
  const windowMs = 15 * 60_000;
  const close = new Date(Math.floor(nowMs / windowMs) * windowMs + windowMs);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "2-digit",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(close).map(({ type, value }) => [type, value]),
  );
  return `${series}-${parts.year}${parts.month.toUpperCase()}${parts.day}${parts.hour}${parts.minute}`;
}
