// Unit tests for the commodity 15-minute market universe.
//
// Covers:
//   1. Market definitions — commodity entries exist, categorized, PYTH-prefixed.
//   2. KALSHI_SERIES — series tickers registered for every commodity.
//   3. Deterministic Kalshi ticker derivation — the KX${SYM}15M-… format used by
//      the bot tick must produce valid commodity tickers (KXGOLD15M-26AUG121400-00
//      was verified live on 2026-08-12).
//   4. isPythProduct routing — commodity products route to Pyth, crypto to Coinbase.
//
// Run with:  pnpm --filter @workspace/api-server test

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeCurrentKalshiEventTicker,
  CRYPTO_COINS,
  COMMODITY_SYMBOLS,
  isPythProduct,
  KALSHI_SERIES,
  PYTH_COMMODITY_FEEDS,
} from "./market-defs.ts";
// (crypto-data.ts itself can't be loaded under node --test — it imports
// logger/pino via extension-less paths; pure market logic lives in market-defs.)

// ── 1. Market definitions ────────────────────────────────────────────────────

test("commodity markets are defined with category and PYTH product prefix", () => {
  for (const sym of ["GOLD", "SILVER", "WTI", "COPPER", "NATGAS"]) {
    const def = CRYPTO_COINS.find((c) => c.symbol === sym);
    assert.ok(def, `${sym} missing from CRYPTO_COINS`);
    assert.equal(def!.category, "commodity", `${sym} must be category=commodity`);
    assert.ok(def!.product.startsWith("PYTH:"), `${sym} product must be PYTH-prefixed`);
  }
});

test("COMMODITY_SYMBOLS is derived from CRYPTO_COINS and contains exactly the commodity symbols", () => {
  assert.deepEqual(
    [...COMMODITY_SYMBOLS].sort(),
    ["COPPER", "GOLD", "NATGAS", "SILVER", "WTI"],
  );
});

test("crypto coins are unchanged — no category, Coinbase products", () => {
  const cryptos = CRYPTO_COINS.filter((c) => c.category !== "commodity");
  assert.equal(cryptos.length, 9, "nine crypto coins expected");
  for (const c of cryptos) {
    assert.ok(c.product.endsWith("-USD"), `${c.symbol} must keep its Coinbase product`);
    assert.ok(!isPythProduct(c.product), `${c.symbol} must not route to Pyth`);
  }
});

// ── 2. Kalshi series registration ────────────────────────────────────────────

test("KALSHI_SERIES contains the verified commodity series tickers", () => {
  assert.equal(KALSHI_SERIES["GOLD"], "KXGOLD15M");
  assert.equal(KALSHI_SERIES["SILVER"], "KXSILVER15M");
  assert.equal(KALSHI_SERIES["WTI"], "KXWTI15M");
  assert.equal(KALSHI_SERIES["COPPER"], "KXCOPPER15M");
  assert.equal(KALSHI_SERIES["NATGAS"], "KXNATGAS15M");
});

test("every market definition has a Kalshi series entry", () => {
  for (const c of CRYPTO_COINS) {
    assert.ok(KALSHI_SERIES[c.symbol], `${c.symbol} missing from KALSHI_SERIES`);
  }
});

// ── 3. Deterministic ticker derivation (mirrors kalshi-bot-tick.ts) ─────────

function deriveExpectedTicker(sym: string, windowKey: string): string {
  const _MONTHS = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
  const closeUtc = new Date(new Date(windowKey + ":00Z").getTime() + 15 * 60 * 1000);
  const closeEdt = new Date(closeUtc.getTime() - 4 * 60 * 60 * 1000);
  const yy  = String(closeEdt.getUTCFullYear()).slice(-2);
  const mon = _MONTHS[closeEdt.getUTCMonth()];
  const dd  = String(closeEdt.getUTCDate()).padStart(2, "0");
  const hh  = String(closeEdt.getUTCHours()).padStart(2, "0");
  const mm  = String(closeEdt.getUTCMinutes()).padStart(2, "0");
  return `KX${sym}15M-${yy}${mon}${dd}${hh}${mm}-${mm}`;
}

test("deterministic ticker derivation produces the observed commodity ticker format", () => {
  // Live-verified 2026-08-12: event KXGOLD15M-26AUG121400 closes 18:00 UTC
  // (= 14:00 EDT), market ticker KXGOLD15M-26AUG121400-00.
  // Window open 17:45 UTC → windowKey "2026-08-12T17:45".
  assert.equal(
    deriveExpectedTicker("GOLD", "2026-08-12T17:45"),
    "KXGOLD15M-26AUG121400-00",
  );
  assert.equal(
    deriveExpectedTicker("SILVER", "2026-08-12T17:45"),
    "KXSILVER15M-26AUG121400-00",
  );
  assert.equal(
    deriveExpectedTicker("WTI", "2026-08-12T17:45"),
    "KXWTI15M-26AUG121400-00",
  );
  assert.equal(
    deriveExpectedTicker("COPPER", "2026-08-12T17:45"),
    "KXCOPPER15M-26AUG121400-00",
  );
  assert.equal(
    deriveExpectedTicker("NATGAS", "2026-08-12T17:45"),
    "KXNATGAS15M-26AUG121400-00",
  );
  // Crypto format is unchanged by the additions.
  assert.equal(
    deriveExpectedTicker("BTC", "2026-07-18T00:15"),
    "KXBTC15M-26JUL172030-30",
  );
});

test("current event ticker uses the DST-aware New York close time", () => {
  assert.equal(
    computeCurrentKalshiEventTicker("COPPER", Date.parse("2026-08-31T18:40:00Z")),
    "KXCOPPER15M-26AUG311445",
  );
  assert.equal(
    computeCurrentKalshiEventTicker("NATGAS", Date.parse("2026-01-14T19:20:00Z")),
    "KXNATGAS15M-26JAN141430",
  );
});

// ── 4. Product routing ───────────────────────────────────────────────────────

test("isPythProduct routes only PYTH-prefixed products", () => {
  assert.equal(isPythProduct("PYTH:Metal.XAU/USD"), true);
  assert.equal(isPythProduct("PYTH:Commodities.USOILSPOT"), true);
  assert.equal(isPythProduct("BTC-USD"), false);
  assert.equal(isPythProduct("ETH-USD"), false);
});

test("commodity products use the canonical Pyth Core feed identities", () => {
  assert.equal(PYTH_COMMODITY_FEEDS.GOLD.symbol, "Metal.XAU/USD");
  assert.equal(PYTH_COMMODITY_FEEDS.SILVER.symbol, "Metal.XAG/USD");
  assert.equal(PYTH_COMMODITY_FEEDS.WTI.symbol, "Commodities.Index.PYTHOIL/USD");
  assert.equal(PYTH_COMMODITY_FEEDS.COPPER.symbol, "Commodities.Index.CU/USD");
  assert.equal(PYTH_COMMODITY_FEEDS.NATGAS.symbol, "Commodities.Index.NATGAS/USD");
  assert.equal(
    CRYPTO_COINS.find((coin) => coin.symbol === "WTI")?.product,
    "PYTH:Commodities.Index.PYTHOIL/USD",
  );
  assert.equal(
    CRYPTO_COINS.find((coin) => coin.symbol === "COPPER")?.product,
    "PYTH:Commodities.Index.CU/USD",
  );
  assert.equal(
    CRYPTO_COINS.find((coin) => coin.symbol === "NATGAS")?.product,
    "PYTH:Commodities.Index.NATGAS/USD",
  );
  for (const feed of Object.values(PYTH_COMMODITY_FEEDS)) {
    assert.match(feed.feedId, /^[0-9a-f]{64}$/);
  }
});
