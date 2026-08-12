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
  { symbol: "GOLD",   product: "PYTH:Metal.XAU/USD",         name: "Gold",      category: "commodity" },
  { symbol: "SILVER", product: "PYTH:Metal.XAG/USD",         name: "Silver",    category: "commodity" },
  { symbol: "WTI",    product: "PYTH:Commodities.USOILSPOT", name: "WTI Crude", category: "commodity" },
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
