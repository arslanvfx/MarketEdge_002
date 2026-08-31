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

/**
 * Canonical Pyth Core feed identities used by Kalshi's commodity contracts.
 * Keep these explicit: execution must not depend on a best-effort feed search
 * during process startup.
 */
export const PYTH_COMMODITY_FEEDS: Record<"GOLD" | "SILVER" | "WTI", PythFeedDef> = {
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
  // ── Commodities (Kalshi 15-min: KXGOLD15M / KXSILVER15M / KXWTI15M) ───────
  // Live spot + candles come from Pyth — the SAME oracle Kalshi settles these
  // markets against (settlement_sources: "Pyth - Gold/Silver/WTI").  Product
  // ids use the "PYTH:" prefix; crypto-data.ts fetch helpers route on it.
  { symbol: "GOLD",   product: PYTH_COMMODITY_FEEDS.GOLD.product,   name: "Gold",      category: "commodity" },
  { symbol: "SILVER", product: PYTH_COMMODITY_FEEDS.SILVER.product, name: "Silver",    category: "commodity" },
  { symbol: "WTI",    product: PYTH_COMMODITY_FEEDS.WTI.product,    name: "WTI Crude", category: "commodity" },
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
};
