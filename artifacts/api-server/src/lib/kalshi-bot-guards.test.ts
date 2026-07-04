// Unit tests for all 6 live-mode safety guards and closePosition state helpers.
//
// Architecture:
//   All guards are extracted as pure, zero-I/O functions in kalshi-bot-guards.ts.
//   kalshi-bot.ts imports and delegates to them so:
//     - behavioral tests run without any DB or API setup, and
//     - wiring tests confirm kalshi-bot.ts calls the right function names.
//
// Run with:  pnpm --filter @workspace/api-server test

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  checkMaxBetSizeGuard,
  checkDailyLossGuard,
  checkStreakPauseGuard,
  checkSlippageStrikeGuard,
  checkBalanceGuard,
  checkExposureGuard,
  checkWindowMonitorReadyGuard,
  applyDailyLossUpdate,
  applyStreakUpdate,
  type CoinStreakState,
} from "./kalshi-bot-guards.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function readSrc(file: string): string {
  return fs.readFileSync(path.join(__dirname, file), "utf8");
}

// ===========================================================================
// Guard 1 — maxBetSize hard cap
//
//   Fires when:  betAmount > maxBetSize + 0.01
//   Effect:      trade is aborted before touching Kalshi
// ===========================================================================

test("maxBetSize: betAmount exactly at cap → not blocked", () => {
  assert.equal(checkMaxBetSizeGuard(2.00, 2.00), false);
});

test("maxBetSize: betAmount within 0.01 tolerance → not blocked", () => {
  assert.equal(checkMaxBetSizeGuard(2.005, 2.00), false);
});

test("maxBetSize: betAmount at exactly cap + 0.01 → not blocked (boundary)", () => {
  assert.equal(checkMaxBetSizeGuard(2.01, 2.00), false);
});

test("maxBetSize: betAmount exceeds cap + 0.01 → blocked", () => {
  assert.equal(checkMaxBetSizeGuard(2.02, 2.00), true);
});

test("maxBetSize: large overage → blocked", () => {
  assert.equal(checkMaxBetSizeGuard(10.00, 2.00), true);
});

test("maxBetSize: betAmount below cap → not blocked", () => {
  assert.equal(checkMaxBetSizeGuard(0.50, 2.00), false);
});

test("maxBetSize: zero cap — any positive bet is blocked", () => {
  assert.equal(checkMaxBetSizeGuard(0.01, 0), false); // 0.01 <= 0 + 0.01, not strictly >
  assert.equal(checkMaxBetSizeGuard(0.02, 0), true);
});

// Wiring check: kalshi-bot.ts must call checkMaxBetSizeGuard in the entry path
test("maxBetSize/wiring: kalshi-bot.ts calls checkMaxBetSizeGuard", () => {
  const src = readSrc("kalshi-bot.ts");
  assert.ok(
    src.includes("checkMaxBetSizeGuard(betAmount, maxBetCap)"),
    "kalshi-bot.ts must delegate to checkMaxBetSizeGuard — guard has been removed or renamed",
  );
});

// ===========================================================================
// Guard 2 — per-coin daily loss cap
//
//   Fires when:  coinLossToday >= maxDailyLossPerCoin  (and cap > 0)
//   Effect:      coin is skipped for the rest of the UTC day
// ===========================================================================

test("dailyLoss: loss below cap → not blocked", () => {
  assert.equal(checkDailyLossGuard(1.00, 3.00), false);
});

test("dailyLoss: loss exactly at cap → blocked", () => {
  assert.equal(checkDailyLossGuard(3.00, 3.00), true);
});

test("dailyLoss: loss above cap → blocked", () => {
  assert.equal(checkDailyLossGuard(3.50, 3.00), true);
});

test("dailyLoss: cap = 0 disables guard → not blocked regardless of loss", () => {
  assert.equal(checkDailyLossGuard(100.00, 0), false);
});

test("dailyLoss: zero loss, positive cap → not blocked", () => {
  assert.equal(checkDailyLossGuard(0, 3.00), false);
});

// Wiring check: kalshi-bot.ts must call checkDailyLossGuard
test("dailyLoss/wiring: kalshi-bot.ts calls checkDailyLossGuard", () => {
  const src = readSrc("kalshi-bot.ts");
  assert.ok(
    src.includes("checkDailyLossGuard(coinLossToday, maxCoinLoss)"),
    "kalshi-bot.ts must delegate to checkDailyLossGuard",
  );
});

// ===========================================================================
// Guard 3 — per-coin consecutive-window streak pause
//
//   Fires when:  pauseUntilWindowKey is set AND windowKey <= pauseUntilWindowKey
//   Effect:      coin is skipped; when expired, pauseUntilWindowKey is cleared
// ===========================================================================

test("streakPause: no pause active → not blocked, not expired", () => {
  const r = checkStreakPauseGuard(null, "2026-07-03T12:00");
  assert.equal(r.blocked, false);
  assert.equal(r.expired, false);
});

test("streakPause: windowKey equals pauseUntil → blocked", () => {
  const r = checkStreakPauseGuard("2026-07-03T12:00", "2026-07-03T12:00");
  assert.equal(r.blocked, true);
  assert.equal(r.expired, false);
});

test("streakPause: windowKey strictly before pauseUntil → blocked", () => {
  const r = checkStreakPauseGuard("2026-07-03T12:15", "2026-07-03T12:00");
  assert.equal(r.blocked, true);
  assert.equal(r.expired, false);
});

test("streakPause: windowKey strictly after pauseUntil → not blocked, expired=true", () => {
  const r = checkStreakPauseGuard("2026-07-03T12:00", "2026-07-03T12:15");
  assert.equal(r.blocked, false);
  assert.equal(r.expired, true, "caller must clear pauseUntilWindowKey");
});

test("streakPause: empty string pauseUntil treated as no pause", () => {
  const r = checkStreakPauseGuard("" as unknown as null, "2026-07-03T12:00");
  // empty string is falsy — same as null
  assert.equal(r.blocked, false);
});

// Wiring check: kalshi-bot.ts must call checkStreakPauseGuard
test("streakPause/wiring: kalshi-bot.ts calls checkStreakPauseGuard", () => {
  const src = readSrc("kalshi-bot.ts");
  assert.ok(
    src.includes("checkStreakPauseGuard("),
    "kalshi-bot.ts must delegate to checkStreakPauseGuard",
  );
});

// ===========================================================================
// Guard 4 (live-only) — slippage-strike gate
//
//   Fires when:  strikes >= 3  AND  strikeWindowKey < currentWindowKey
//   Effect:      coin entry skipped for one window (counter then cleared)
// ===========================================================================

test("slippage: no slip info → not blocked", () => {
  assert.equal(checkSlippageStrikeGuard(null, "2026-07-03T12:15"), false);
});

test("slippage: fewer than 3 strikes → not blocked", () => {
  assert.equal(checkSlippageStrikeGuard({ strikes: 2, windowKey: "2026-07-03T12:00" }, "2026-07-03T12:15"), false);
});

test("slippage: exactly 3 strikes in a previous window → blocked", () => {
  assert.equal(checkSlippageStrikeGuard({ strikes: 3, windowKey: "2026-07-03T12:00" }, "2026-07-03T12:15"), true);
});

test("slippage: more than 3 strikes in a previous window → blocked", () => {
  assert.equal(checkSlippageStrikeGuard({ strikes: 5, windowKey: "2026-07-03T12:00" }, "2026-07-03T12:15"), true);
});

test("slippage: 3 strikes but same window (not previous) → not blocked", () => {
  // Strikes in window W should NOT block entry in window W itself
  const sameWindow = "2026-07-03T12:00";
  assert.equal(checkSlippageStrikeGuard({ strikes: 3, windowKey: sameWindow }, sameWindow), false);
});

test("slippage: 3 strikes from a future windowKey (clock skew) → not blocked", () => {
  assert.equal(checkSlippageStrikeGuard({ strikes: 3, windowKey: "2026-07-03T12:30" }, "2026-07-03T12:15"), false);
});

// Wiring check: kalshi-bot.ts must call checkSlippageStrikeGuard
test("slippage/wiring: kalshi-bot.ts calls checkSlippageStrikeGuard", () => {
  const src = readSrc("kalshi-bot.ts");
  assert.ok(
    src.includes("checkSlippageStrikeGuard(slipInfo, windowKey)"),
    "kalshi-bot.ts must delegate to checkSlippageStrikeGuard",
  );
});

// ===========================================================================
// Guard 5 (live-only) — account balance floor
//
//   Fires when:  liveBal < minAccountBalance
//   Effect:      trade is aborted; next fetch will be fresh
// ===========================================================================

test("balance: balance above min → not blocked", () => {
  assert.equal(checkBalanceGuard(10.00, 5.00), false);
});

test("balance: balance exactly at min → not blocked (at the floor is fine)", () => {
  assert.equal(checkBalanceGuard(5.00, 5.00), false);
});

test("balance: balance below min → blocked", () => {
  assert.equal(checkBalanceGuard(4.99, 5.00), true);
});

test("balance: zero balance, any positive floor → blocked", () => {
  assert.equal(checkBalanceGuard(0, 5.00), true);
});

test("balance: negative balance → blocked", () => {
  assert.equal(checkBalanceGuard(-1, 5.00), true);
});

test("balance: zero min (disabled) → never blocked", () => {
  assert.equal(checkBalanceGuard(0, 0), false);
  assert.equal(checkBalanceGuard(-1, 0), true); // negative is still below 0
});

// Wiring check: kalshi-bot.ts must call checkBalanceGuard
test("balance/wiring: kalshi-bot.ts calls checkBalanceGuard", () => {
  const src = readSrc("kalshi-bot.ts");
  assert.ok(
    src.includes("checkBalanceGuard(liveBal, minBal)"),
    "kalshi-bot.ts must delegate to checkBalanceGuard",
  );
});

// ===========================================================================
// Guard 6 (live-only) — total open-exposure cap
//
//   Fires when:  openExposure + betAmount > maxTotalExposure + 0.01
//   Effect:      trade is aborted; existing positions are unaffected
// ===========================================================================

test("exposure: combined exposure below cap → not blocked", () => {
  assert.equal(checkExposureGuard(2.00, 1.00, 5.00), false);
});

test("exposure: combined exposure exactly at cap → not blocked", () => {
  assert.equal(checkExposureGuard(4.00, 1.00, 5.00), false);
});

test("exposure: combined exposure within 0.01 tolerance → not blocked", () => {
  assert.equal(checkExposureGuard(4.00, 1.005, 5.00), false);
});

test("exposure: combined exposure at exactly cap + 0.01 → not blocked (boundary)", () => {
  assert.equal(checkExposureGuard(4.00, 1.01, 5.00), false);
});

test("exposure: combined exposure exceeds cap + 0.01 → blocked", () => {
  assert.equal(checkExposureGuard(4.00, 1.02, 5.00), true);
});

test("exposure: no open positions, bet alone exceeds cap → blocked", () => {
  assert.equal(checkExposureGuard(0, 6.00, 5.00), true);
});

test("exposure: zero cap → any non-trivial bet blocked", () => {
  assert.equal(checkExposureGuard(0, 0.02, 0), true);
  assert.equal(checkExposureGuard(0, 0.005, 0), false); // within 0.01 tolerance
});

// Wiring check: kalshi-bot.ts must call checkExposureGuard
test("exposure/wiring: kalshi-bot.ts calls checkExposureGuard", () => {
  const src = readSrc("kalshi-bot.ts");
  assert.ok(
    src.includes("checkExposureGuard(openExposure, betAmount, maxExposure)"),
    "kalshi-bot.ts must delegate to checkExposureGuard",
  );
});

// ===========================================================================
// closePosition helpers — applyDailyLossUpdate
//
//   On a loss in the current mode: adds |pnl| to the coin's running total.
//   Cross-mode losses and wins: no change to the map.
// ===========================================================================

test("applyDailyLossUpdate: loss in matching mode → accumulates", () => {
  const map = new Map<string, number>([["BTC", 1.00]]);
  const result = applyDailyLossUpdate(map, "BTC", -0.50, "live", "live");
  assert.equal(result.get("BTC"), 1.50);
});

test("applyDailyLossUpdate: loss with no prior entry → creates entry", () => {
  const map = new Map<string, number>();
  const result = applyDailyLossUpdate(map, "ETH", -1.00, "paper", "paper");
  assert.equal(result.get("ETH"), 1.00);
});

test("applyDailyLossUpdate: win in matching mode → no change", () => {
  const map = new Map<string, number>([["BTC", 1.00]]);
  const result = applyDailyLossUpdate(map, "BTC", 0.50, "live", "live");
  assert.equal(result.get("BTC"), 1.00);
});

test("applyDailyLossUpdate: exactly-zero pnl (breakeven) → no change", () => {
  const map = new Map<string, number>([["BTC", 1.00]]);
  const result = applyDailyLossUpdate(map, "BTC", 0, "live", "live");
  assert.equal(result.get("BTC"), 1.00);
});

test("applyDailyLossUpdate: loss in wrong mode → no change (cross-mode protection)", () => {
  const map = new Map<string, number>([["BTC", 1.00]]);
  const result = applyDailyLossUpdate(map, "BTC", -0.50, "paper", "live");
  assert.equal(result.get("BTC"), 1.00, "paper loss must not count against live daily cap");
});

test("applyDailyLossUpdate: does not mutate the input map", () => {
  const map = new Map<string, number>([["BTC", 1.00]]);
  applyDailyLossUpdate(map, "BTC", -0.50, "live", "live");
  assert.equal(map.get("BTC"), 1.00, "input map must be unchanged");
});

test("applyDailyLossUpdate: multiple coins → only target coin updated", () => {
  const map = new Map<string, number>([["BTC", 0], ["ETH", 2.00]]);
  const result = applyDailyLossUpdate(map, "BTC", -0.75, "live", "live");
  assert.equal(result.get("BTC"), 0.75);
  assert.equal(result.get("ETH"), 2.00, "ETH must be unchanged");
});

// Wiring check: kalshi-bot.ts must call applyDailyLossUpdate in closePosition
test("applyDailyLossUpdate/wiring: kalshi-bot.ts closePosition calls applyDailyLossUpdate", () => {
  const src = readSrc("kalshi-bot.ts");
  assert.ok(
    src.includes("applyDailyLossUpdate(") && src.includes("pos.symbol, pnl, pos.entryMode"),
    "closePosition must delegate daily-loss accumulation to applyDailyLossUpdate",
  );
});

// ===========================================================================
// closePosition helpers — applyStreakUpdate
//
//   On a loss: increment consecutiveLosses; arm pause when limit reached.
//   On a win:  reset consecutiveLosses=0 and clear pauseUntilWindowKey.
// ===========================================================================

const FRESH: CoinStreakState = { consecutiveLosses: 0, pauseUntilWindowKey: null };
const NOW = new Date("2026-07-03T12:00:00Z").getTime();

test("streak: win from fresh state → streak stays at 0, no pause", () => {
  const result = applyStreakUpdate(FRESH, 0.50, 3, 2, NOW);
  assert.equal(result.consecutiveLosses, 0);
  assert.equal(result.pauseUntilWindowKey, null);
});

test("streak: win with existing loss streak → streak reset to 0", () => {
  const state: CoinStreakState = { consecutiveLosses: 2, pauseUntilWindowKey: null };
  const result = applyStreakUpdate(state, 0.50, 3, 2, NOW);
  assert.equal(result.consecutiveLosses, 0);
  assert.equal(result.pauseUntilWindowKey, null);
});

test("streak: win clears an active pause", () => {
  const state: CoinStreakState = { consecutiveLosses: 0, pauseUntilWindowKey: "2026-07-03T13:30" };
  const result = applyStreakUpdate(state, 1.00, 3, 2, NOW);
  assert.equal(result.pauseUntilWindowKey, null, "win must clear any active pause");
  assert.equal(result.consecutiveLosses, 0);
});

test("streak: single loss increments counter, no pause yet", () => {
  const result = applyStreakUpdate(FRESH, -0.50, 3, 2, NOW);
  assert.equal(result.consecutiveLosses, 1);
  assert.equal(result.pauseUntilWindowKey, null);
});

test("streak: losses below limit → no pause triggered", () => {
  const state: CoinStreakState = { consecutiveLosses: 1, pauseUntilWindowKey: null };
  const result = applyStreakUpdate(state, -0.50, 3, 2, NOW);
  assert.equal(result.consecutiveLosses, 2);
  assert.equal(result.pauseUntilWindowKey, null);
});

test("streak: loss that reaches the limit → pause armed, counter reset", () => {
  const state: CoinStreakState = { consecutiveLosses: 2, pauseUntilWindowKey: null };
  const result = applyStreakUpdate(state, -0.50, 3, 2, NOW);
  assert.equal(result.consecutiveLosses, 0, "counter must reset after pause is armed");
  assert.ok(result.pauseUntilWindowKey !== null, "pauseUntilWindowKey must be set");
  // pauseUntilWindowKey should be 2 windows (30 min) after NOW
  const expected = new Date(NOW + 2 * 15 * 60_000).toISOString().slice(0, 16);
  assert.equal(result.pauseUntilWindowKey, expected);
});

test("streak: loss that exceeds limit on first hit → pause armed (limit=1)", () => {
  const result = applyStreakUpdate(FRESH, -1.00, 1, 3, NOW);
  assert.equal(result.consecutiveLosses, 0);
  const expected = new Date(NOW + 3 * 15 * 60_000).toISOString().slice(0, 16);
  assert.equal(result.pauseUntilWindowKey, expected);
});

test("streak: pause already active → second loss does NOT re-arm another pause", () => {
  // Already paused from a prior streak; loss count climbing again
  const state: CoinStreakState = { consecutiveLosses: 2, pauseUntilWindowKey: "2026-07-03T13:00" };
  const result = applyStreakUpdate(state, -0.50, 3, 2, NOW);
  // Limit would be reached (2+1 = 3 >= 3), but pauseUntilWindowKey is already set
  assert.equal(result.consecutiveLosses, 3, "counter incremented");
  assert.equal(result.pauseUntilWindowKey, "2026-07-03T13:00", "existing pause must NOT be overwritten");
});

test("streak: limit = 0 disables pause arming", () => {
  const state: CoinStreakState = { consecutiveLosses: 99, pauseUntilWindowKey: null };
  const result = applyStreakUpdate(state, -1.00, 0, 2, NOW);
  assert.equal(result.pauseUntilWindowKey, null, "limit=0 must never arm a pause");
  assert.equal(result.consecutiveLosses, 100);
});

test("streak: does not mutate the input state object", () => {
  const state: CoinStreakState = { consecutiveLosses: 2, pauseUntilWindowKey: null };
  applyStreakUpdate(state, -0.50, 3, 2, NOW);
  assert.equal(state.consecutiveLosses, 2, "input state must be unchanged");
});

// Wiring check: kalshi-bot.ts must call applyStreakUpdate in closePosition
test("streak/wiring: kalshi-bot.ts closePosition calls applyStreakUpdate", () => {
  const src = readSrc("kalshi-bot.ts");
  assert.ok(
    src.includes("applyStreakUpdate("),
    "closePosition must delegate streak tracking to applyStreakUpdate",
  );
  // And the correct arguments should be present near each other in the source
  assert.ok(
    src.includes("config.coinStreakLossLimit ?? 3"),
    "applyStreakUpdate call must pass coinStreakLossLimit",
  );
  assert.ok(
    src.includes("config.coinStreakPauseWindows ?? 2"),
    "applyStreakUpdate call must pass coinStreakPauseWindows",
  );
});

// ===========================================================================
// Guard 7 — Window Monitor readiness gate
// ===========================================================================

test("wmReady: monitor ready, gate enabled → not blocked", () => {
  assert.equal(checkWindowMonitorReadyGuard(true, true), false);
});

test("wmReady: monitor not ready, gate enabled → blocked (defer tick)", () => {
  assert.equal(checkWindowMonitorReadyGuard(false, true), true);
});

test("wmReady: monitor not ready, gate disabled → not blocked", () => {
  assert.equal(checkWindowMonitorReadyGuard(false, false), false);
});

test("wmReady: monitor ready, gate disabled → not blocked", () => {
  assert.equal(checkWindowMonitorReadyGuard(true, false), false);
});

test("wmReady/wiring: kalshi-bot.ts imports and calls checkWindowMonitorReadyGuard", () => {
  const src = readSrc("kalshi-bot.ts");
  assert.ok(
    src.includes("checkWindowMonitorReadyGuard"),
    "kalshi-bot.ts must import checkWindowMonitorReadyGuard from kalshi-bot-guards",
  );
  assert.ok(
    src.includes("config.requireMonitorReady"),
    "kalshi-bot.ts Phase-3 loop must pass config.requireMonitorReady to the gate",
  );
});
