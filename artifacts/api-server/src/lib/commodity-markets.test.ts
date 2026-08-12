// Unit tests for the commodity 15-min market additions (GOLD / SILVER / WTI).
//
// Covers:
//   1. Market definitions — commodity entries exist, categorized, PYTH-prefixed.
//   2. KALSHI_SERIES — series tickers registered for all three commodities.
//   3. Deterministic Kalshi ticker derivation — the KX${SYM}15M-… format used by
//      the bot tick must produce valid commodity tickers (KXGOLD15M-26AUG121400-00
//      was verified live on 2026-08-12).
//   4. isPythProduct routing — commodity products route to Pyth, crypto to Coinbase.
//
// Run with:  pnpm --filter @workspace/api-server test

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CRYPTO_COINS,
  COMMODITY_SYMBOLS,
  isPythProduct,
  KALSHI_SERIES,
} from "./market-defs.ts";
// (crypto-data.ts itself can't be loaded under node --test — it imports
// logger/pino via extension-less paths; pure market logic lives in market-defs.)

// ── 1. Market definitions ────────────────────────────────────────────────────

test("commodity markets are defined with category and PYTH product prefix", () => {
  for (const sym of ["GOLD", "SILVER", "WTI"]) {
    const def = CRYPTO_COINS.find((c) => c.symbol === sym);
    assert.ok(def, `${sym} missing from CRYPTO_COINS`);
    assert.equal(def!.category, "commodity", `${sym} must be category=commodity`);
    assert.ok(def!.product.startsWith("PYTH:"), `${sym} product must be PYTH-prefixed`);
  }
});

test("COMMODITY_SYMBOLS is derived from CRYPTO_COINS and contains exactly the commodity symbols", () => {
  assert.deepEqual([...COMMODITY_SYMBOLS].sort(), ["GOLD", "SILVER", "WTI"]);
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
  // Crypto format is unchanged by the additions.
  assert.equal(
    deriveExpectedTicker("BTC", "2026-07-18T00:15"),
    "KXBTC15M-26JUL172030-30",
  );
});

// ── 4. Product routing ───────────────────────────────────────────────────────

test("isPythProduct routes only PYTH-prefixed products", () => {
  assert.equal(isPythProduct("PYTH:Metal.XAU/USD"), true);
  assert.equal(isPythProduct("PYTH:Commodities.USOILSPOT"), true);
  assert.equal(isPythProduct("BTC-USD"), false);
  assert.equal(isPythProduct("ETH-USD"), false);
});
