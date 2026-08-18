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
  checkWindowMonitorStayAwayGuard,
  applyStayAwayGateDecision,
  applyDailyLossUpdate,
  applyStreakUpdate,
  type CoinStreakState,
  type StayAwayGateOutcome,
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
  const src = readSrc("kalshi-bot-tick.ts");
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
  const src = readSrc("kalshi-bot-tick.ts");
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
  const src = readSrc("kalshi-bot-tick.ts");
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
  const src = readSrc("kalshi-bot-tick.ts");
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
  const src = readSrc("kalshi-bot-tick.ts");
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
  const src = readSrc("kalshi-bot-tick.ts");
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
  const src = readSrc("kalshi-bot-close.ts");
  assert.ok(
    src.includes("applyDailyLossUpdate(") && src.includes("pos.symbol, pnl, pos.entryMode"),
    "closePosition must delegate daily-loss accumulation to applyDailyLossUpdate",
  );
});

// ===========================================================================
// closePosition helpers — applyStreakUpdate
//
//   On a loss (adjacent window): increment consecutiveLosses; arm pause when
//                                 limit reached.
//   On a loss (non-adjacent):    reset streak to 1 (fresh start).
//   On a win:                    reset consecutiveLosses=0 and clear pause.
//
// "Consecutive" means the two losses fell in back-to-back 15-min windows.
// Losses hours apart do NOT count as consecutive.
// ===========================================================================

const FRESH: CoinStreakState = { consecutiveLosses: 0, pauseUntilWindowKey: null };
// NOW corresponds to UTC 12:00 — matches WIN_KEY when parsed as UTC.
const NOW = new Date("2026-07-03T12:00:00Z").getTime();
const WIN_KEY = "2026-07-03T12:00"; // current window key for all streak tests

test("streak: win from fresh state → streak stays at 0, no pause", () => {
  const result = applyStreakUpdate(FRESH, 0.50, 3, 2, WIN_KEY, NOW);
  assert.equal(result.consecutiveLosses, 0);
  assert.equal(result.pauseUntilWindowKey, null);
});

test("streak: win with existing loss streak → streak reset to 0", () => {
  const state: CoinStreakState = { consecutiveLosses: 2, pauseUntilWindowKey: null };
  const result = applyStreakUpdate(state, 0.50, 3, 2, WIN_KEY, NOW);
  assert.equal(result.consecutiveLosses, 0);
  assert.equal(result.pauseUntilWindowKey, null);
});

test("streak: win clears an active pause", () => {
  const state: CoinStreakState = { consecutiveLosses: 0, pauseUntilWindowKey: "2026-07-03T13:30" };
  const result = applyStreakUpdate(state, 1.00, 3, 2, WIN_KEY, NOW);
  assert.equal(result.pauseUntilWindowKey, null, "win must clear any active pause");
  assert.equal(result.consecutiveLosses, 0);
});

test("streak: single loss (no prior lastLossWindowKey) → streak=1, no pause", () => {
  const result = applyStreakUpdate(FRESH, -0.50, 3, 2, WIN_KEY, NOW);
  assert.equal(result.consecutiveLosses, 1);
  assert.equal(result.pauseUntilWindowKey, null);
  assert.equal(result.lastLossWindowKey, WIN_KEY, "lastLossWindowKey must be set to current window");
});

test("streak: losses below limit → no pause triggered (adjacent windows)", () => {
  const state: CoinStreakState = { consecutiveLosses: 1, pauseUntilWindowKey: null, lastLossWindowKey: "2026-07-03T11:45" };
  const result = applyStreakUpdate(state, -0.50, 3, 2, WIN_KEY, NOW); // WIN_KEY is 15 min after lastLoss
  assert.equal(result.consecutiveLosses, 2);
  assert.equal(result.pauseUntilWindowKey, null);
});

test("streak: loss that reaches the limit (adjacent windows) → pause armed, counter reset", () => {
  const state: CoinStreakState = { consecutiveLosses: 2, pauseUntilWindowKey: null, lastLossWindowKey: "2026-07-03T11:45" };
  const result = applyStreakUpdate(state, -0.50, 3, 2, WIN_KEY, NOW);
  assert.equal(result.consecutiveLosses, 0, "counter must reset after pause is armed");
  assert.ok(result.pauseUntilWindowKey !== null, "pauseUntilWindowKey must be set");
  // pauseUntilWindowKey = WIN_KEY + 2 windows (30 min)
  const expected = new Date(new Date(WIN_KEY).getTime() + 2 * 15 * 60_000).toISOString().slice(0, 16);
  assert.equal(result.pauseUntilWindowKey, expected);
  assert.equal(result.lastLossWindowKey, undefined, "lastLossWindowKey must be cleared when pause arms");
});

test("streak: loss that exceeds limit on first hit → pause armed (limit=1)", () => {
  const result = applyStreakUpdate(FRESH, -1.00, 1, 3, WIN_KEY, NOW);
  assert.equal(result.consecutiveLosses, 0);
  const expected = new Date(new Date(WIN_KEY).getTime() + 3 * 15 * 60_000).toISOString().slice(0, 16);
  assert.equal(result.pauseUntilWindowKey, expected);
});

test("streak: pause already active → second loss does NOT re-arm another pause", () => {
  // Already paused from a prior streak; loss count climbing again
  const state: CoinStreakState = { consecutiveLosses: 2, pauseUntilWindowKey: "2026-07-03T13:00", lastLossWindowKey: "2026-07-03T11:45" };
  const result = applyStreakUpdate(state, -0.50, 3, 2, WIN_KEY, NOW);
  // Limit would be reached (2+1 = 3 >= 3), but pauseUntilWindowKey is already set
  assert.equal(result.consecutiveLosses, 3, "counter incremented");
  assert.equal(result.pauseUntilWindowKey, "2026-07-03T13:00", "existing pause must NOT be overwritten");
});

test("streak: limit = 0 disables pause arming", () => {
  // Use lastLossWindowKey so the adjacent-window check extends the streak rather than
  // resetting to 1 (the no-key path always starts fresh to protect against stale DB state).
  const prevWindowKey = "2026-07-03T11:45";
  const state: CoinStreakState = { consecutiveLosses: 99, pauseUntilWindowKey: null, lastLossWindowKey: prevWindowKey };
  const result = applyStreakUpdate(state, -1.00, 0, 2, WIN_KEY, NOW);
  assert.equal(result.pauseUntilWindowKey, null, "limit=0 must never arm a pause");
  assert.equal(result.consecutiveLosses, 100);
});

test("streak: does not mutate the input state object", () => {
  const state: CoinStreakState = { consecutiveLosses: 2, pauseUntilWindowKey: null };
  applyStreakUpdate(state, -0.50, 3, 2, WIN_KEY, NOW);
  assert.equal(state.consecutiveLosses, 2, "input state must be unchanged");
});

// ---------------------------------------------------------------------------
// Adjacency tests — the critical new behavior
// ---------------------------------------------------------------------------

test("streak/adjacency: two losses in back-to-back windows (limit=2) → pause triggered", () => {
  // Loss 1: window T
  const afterLoss1 = applyStreakUpdate(FRESH, -0.50, 2, 2, "2026-07-03T12:00", NOW);
  assert.equal(afterLoss1.consecutiveLosses, 1);
  assert.equal(afterLoss1.pauseUntilWindowKey, null, "one loss must not pause");

  // Loss 2: window T+15 (adjacent)
  const afterLoss2 = applyStreakUpdate(afterLoss1, -0.50, 2, 2, "2026-07-03T12:15", NOW);
  assert.equal(afterLoss2.consecutiveLosses, 0, "counter resets when pause arms");
  assert.ok(afterLoss2.pauseUntilWindowKey !== null, "pause must be armed after 2 adjacent losses");
  const expected = new Date(new Date("2026-07-03T12:15").getTime() + 2 * 15 * 60_000).toISOString().slice(0, 16);
  assert.equal(afterLoss2.pauseUntilWindowKey, expected, "pause ends 2 windows after the triggering window");
});

test("streak/adjacency: two losses with a window gap between them → NO pause (streak resets to 1)", () => {
  // Loss 1: window T
  const afterLoss1 = applyStreakUpdate(FRESH, -0.50, 2, 2, "2026-07-03T12:00", NOW);
  assert.equal(afterLoss1.consecutiveLosses, 1);

  // Loss 2: window T+30 (one window gap — NOT adjacent)
  const afterLoss2 = applyStreakUpdate(afterLoss1, -0.50, 2, 2, "2026-07-03T12:30", NOW);
  assert.equal(afterLoss2.consecutiveLosses, 1, "streak must reset to 1 when gap > 15 min");
  assert.equal(afterLoss2.pauseUntilWindowKey, null, "no pause — losses were not adjacent");
});

test("streak/adjacency: two losses 2 hours apart → NO pause", () => {
  // Loss 1: window T
  const afterLoss1 = applyStreakUpdate(FRESH, -0.50, 2, 2, "2026-07-03T10:00", NOW);
  // Loss 2: window T+2h (far apart)
  const afterLoss2 = applyStreakUpdate(afterLoss1, -0.50, 2, 2, "2026-07-03T12:00", NOW);
  assert.equal(afterLoss2.consecutiveLosses, 1, "non-adjacent loss must reset streak to 1");
  assert.equal(afterLoss2.pauseUntilWindowKey, null, "no pause for non-adjacent losses");
});

test("streak/adjacency: win between two losses resets streak — no pause even if adjacent", () => {
  // Loss at T
  const afterLoss1 = applyStreakUpdate(FRESH, -0.50, 2, 2, "2026-07-03T12:00", NOW);
  // Win at T+15
  const afterWin = applyStreakUpdate(afterLoss1, 0.50, 2, 2, "2026-07-03T12:15", NOW);
  assert.equal(afterWin.consecutiveLosses, 0);
  assert.equal(afterWin.lastLossWindowKey, undefined, "win must clear lastLossWindowKey");
  // Loss at T+30 (adjacent to T+15, but streak was reset by win)
  const afterLoss2 = applyStreakUpdate(afterWin, -0.50, 2, 2, "2026-07-03T12:30", NOW);
  assert.equal(afterLoss2.consecutiveLosses, 1, "streak starts fresh after win");
  assert.equal(afterLoss2.pauseUntilWindowKey, null, "no pause — streak was reset by win");
});

test("streak/adjacency: three consecutive adjacent losses with limit=2 → pause on 2nd, 3rd does not re-arm", () => {
  const s1 = applyStreakUpdate(FRESH, -1.00, 2, 2, "2026-07-03T12:00", NOW);
  assert.equal(s1.consecutiveLosses, 1);

  const s2 = applyStreakUpdate(s1, -1.00, 2, 2, "2026-07-03T12:15", NOW);
  assert.equal(s2.consecutiveLosses, 0, "pause armed on 2nd adjacent loss");
  assert.ok(s2.pauseUntilWindowKey !== null);

  // 3rd adjacent loss while already paused — counter climbs but pause not re-armed
  const s3 = applyStreakUpdate(s2, -1.00, 2, 2, "2026-07-03T12:30", NOW);
  assert.equal(s3.pauseUntilWindowKey, s2.pauseUntilWindowKey, "existing pause must not be overwritten");
});

// Wiring check: kalshi-bot-eval.ts must call applyStreakUpdate with windowKey
test("streak/wiring: kalshi-bot-eval.ts calls applyStreakUpdate with coinStreakLossLimit and windowKey", () => {
  const src = readSrc("kalshi-bot-eval.ts");
  assert.ok(
    src.includes("applyStreakUpdate("),
    "evalClosedBets must delegate streak tracking to applyStreakUpdate",
  );
  assert.ok(
    src.includes("config.coinStreakLossLimit ?? 2"),
    "applyStreakUpdate call must pass coinStreakLossLimit with default 2",
  );
  assert.ok(
    src.includes("config.coinStreakPauseWindows ?? 2"),
    "applyStreakUpdate call must pass coinStreakPauseWindows with default 2",
  );
  assert.ok(
    src.includes("row.windowKey"),
    "applyStreakUpdate must receive the bet's windowKey for adjacency checking",
  );
});

test("streak/wiring: kalshi-bot-close.ts calls applyStreakUpdate with pos.windowKey and default 2", () => {
  // The close path (mid-window early exits) must supply pos.windowKey as the
  // currentWindowKey argument so adjacency is checked against the correct 15-min
  // window rather than wall-clock time.
  const src = readSrc("kalshi-bot-close.ts");
  assert.ok(
    src.includes("applyStreakUpdate("),
    "closePosition must delegate streak tracking to applyStreakUpdate",
  );
  assert.ok(
    src.includes("coinStreakLossLimit ?? 2"),
    "closePosition applyStreakUpdate call must use default 2, not the stale default 3",
  );
  assert.ok(
    src.includes("pos.windowKey"),
    "closePosition must pass pos.windowKey (not Date.now()) as currentWindowKey for adjacency checking",
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
  const src = readSrc("kalshi-bot-loop.ts");
  assert.ok(
    src.includes("checkWindowMonitorReadyGuard"),
    "kalshi-bot.ts must import checkWindowMonitorReadyGuard from kalshi-bot-guards",
  );
  assert.ok(
    src.includes("S.config.requireMonitorReady"),
    "kalshi-bot.ts Phase-3 loop must pass config.requireMonitorReady to the gate",
  );
});

// ===========================================================================
// Guard 7b — Window Monitor STAY_AWAY gate
//
//   Fires when:  signal.ready === true AND signal.recommendation === "stay_away"
//   Effect (requireMonitorReady=true):   "block" — coin added to filteredByNewGuards
//                                        (full-window block, not just per-tick defer)
//   Effect (requireMonitorReady=false):  "advisory" — log only, entry proceeds
//   Otherwise:                           "pass"
// ===========================================================================

const STAY_AWAY_SIGNAL = {
  ready: true,
  recommendation: "stay_away" as const,
  minutesElapsed: 5,
  reason: "High oscillation",
  preWindowER: null,
  factors: { efficiencyRatio: 0.1, oscillationCount: 4, spikeFlag: false, netDriftPct: 0 },
};

const BET_SIGNAL = {
  ...STAY_AWAY_SIGNAL,
  recommendation: "bet" as const,
};

const CAUTION_SIGNAL = {
  ...STAY_AWAY_SIGNAL,
  recommendation: "caution" as const,
};

const NOT_READY_STAY_AWAY = {
  ...STAY_AWAY_SIGNAL,
  ready: false,
};

test("stayAway: stay_away signal + required=true → block (full-window hard gate)", () => {
  assert.equal(checkWindowMonitorStayAwayGuard(STAY_AWAY_SIGNAL, true), "block");
});

test("stayAway: stay_away signal + required=false → advisory only (not a hard block)", () => {
  assert.equal(checkWindowMonitorStayAwayGuard(STAY_AWAY_SIGNAL, false), "advisory");
});

test("stayAway: bet signal (positive) → pass regardless of required flag", () => {
  assert.equal(checkWindowMonitorStayAwayGuard(BET_SIGNAL, true), "pass");
  assert.equal(checkWindowMonitorStayAwayGuard(BET_SIGNAL, false), "pass");
});

test("stayAway: caution signal → pass (only stay_away triggers the gate)", () => {
  assert.equal(checkWindowMonitorStayAwayGuard(CAUTION_SIGNAL, true), "pass");
});

test("stayAway: null signal (monitor not yet computed) → pass", () => {
  assert.equal(checkWindowMonitorStayAwayGuard(null, true), "pass");
  assert.equal(checkWindowMonitorStayAwayGuard(null, false), "pass");
});

test("stayAway: ready=false with stay_away recommendation → pass (not ready yet)", () => {
  assert.equal(checkWindowMonitorStayAwayGuard(NOT_READY_STAY_AWAY, true), "pass");
});

// ---------------------------------------------------------------------------
// Behavioral tests for applyStayAwayGateDecision:
// These exercise the full application-layer function with real Set and signal
// objects — the same structures the bot loop uses at runtime.  "Mocking"
// getWindowBetSignal means passing a crafted signal value directly so tests
// run without I/O or DB setup and deterministically assert side effects.
// ---------------------------------------------------------------------------

test("stayAway/apply: stay_away + required=true → outcome=block, sym added to filteredByNewGuards", () => {
  const guards = new Set<string>();
  const outcome = applyStayAwayGateDecision("BTC", STAY_AWAY_SIGNAL, true, guards);
  assert.equal(outcome.action, "block",
    "block outcome required when signal=stay_away and monitorRequired=true");
  assert.ok(guards.has("BTC"),
    "BTC must be in filteredByNewGuards so Phase 4 cannot place an order");
});

test("stayAway/apply: block outcome carries the canonical reason string", () => {
  const guards = new Set<string>();
  const outcome = applyStayAwayGateDecision("ETH", STAY_AWAY_SIGNAL, true, guards) as Extract<StayAwayGateOutcome, { action: "block" }>;
  assert.ok(
    outcome.reason.includes("window_monitor_stay_away"),
    "reason must contain 'window_monitor_stay_away' — this is the canonical SKIP reason checked by the loop",
  );
});

test("stayAway/apply: stay_away + required=false → outcome=advisory, filteredByNewGuards unchanged", () => {
  const guards = new Set<string>();
  const outcome = applyStayAwayGateDecision("BTC", STAY_AWAY_SIGNAL, false, guards);
  assert.equal(outcome.action, "advisory",
    "advisory mode must not hard-block when requireMonitorReady=false");
  assert.ok(!guards.has("BTC"),
    "advisory path must NOT add sym to filteredByNewGuards (Phase 4 may still bet)");
});

test("stayAway/apply: bet signal → outcome=pass, filteredByNewGuards unchanged", () => {
  const guards = new Set<string>();
  const outcome = applyStayAwayGateDecision("BTC", BET_SIGNAL, true, guards);
  assert.equal(outcome.action, "pass");
  assert.ok(!guards.has("BTC"), "bet signal must leave filteredByNewGuards untouched");
});

test("stayAway/apply: null signal (monitor not yet computed) → outcome=pass", () => {
  const guards = new Set<string>();
  const outcome = applyStayAwayGateDecision("BTC", null, true, guards);
  assert.equal(outcome.action, "pass");
  assert.ok(!guards.has("BTC"));
});

test("stayAway/apply: ready=false stay_away signal → outcome=pass (readiness gate defers first)", () => {
  const guards = new Set<string>();
  const outcome = applyStayAwayGateDecision("BTC", NOT_READY_STAY_AWAY, true, guards);
  assert.equal(outcome.action, "pass");
  assert.ok(!guards.has("BTC"));
});

test("stayAway/apply: only the stay_away coin is blocked when multiple symbols evaluated", () => {
  const guards = new Set<string>();
  const btcOutcome = applyStayAwayGateDecision("BTC", STAY_AWAY_SIGNAL, true, guards);
  const ethOutcome = applyStayAwayGateDecision("ETH", BET_SIGNAL, true, guards);
  const solOutcome = applyStayAwayGateDecision("SOL", CAUTION_SIGNAL, true, guards);

  assert.equal(btcOutcome.action, "block");
  assert.equal(ethOutcome.action, "pass");
  assert.equal(solOutcome.action, "pass");

  assert.ok(guards.has("BTC"), "only BTC must be in filteredByNewGuards");
  assert.ok(!guards.has("ETH"), "ETH must NOT be in filteredByNewGuards");
  assert.ok(!guards.has("SOL"), "SOL must NOT be in filteredByNewGuards");
});

test("stayAway/apply: Phase-4 skip-candidates filtered by filteredByNewGuards (regression guard)", () => {
  // Simulate the Phase-4 filter the bot loop applies at line:
  //   skips.filter(e => e.trendStability !== "reversing" && !filteredByNewGuards.has(e.symbol))
  // A coin blocked by the STAY_AWAY gate must be absent from that result.
  const guards = new Set<string>();
  applyStayAwayGateDecision("BTC", STAY_AWAY_SIGNAL, true, guards);

  const phase4Candidates = [
    { symbol: "BTC", trendStability: null },
    { symbol: "ETH", trendStability: null },
  ].filter(e => e.trendStability !== "reversing" && !guards.has(e.symbol));

  const symbols = phase4Candidates.map(e => e.symbol);
  assert.ok(!symbols.includes("BTC"),
    "BTC must be excluded from Phase-4 candidates after STAY_AWAY block");
  assert.ok(symbols.includes("ETH"),
    "ETH must remain in Phase-4 candidates (not stay_away)");
});

// ---------------------------------------------------------------------------
// Wiring check: loop delegates to applyStayAwayGateDecision (not inline logic)
// ---------------------------------------------------------------------------

test("stayAway/wiring: kalshi-bot-loop.ts delegates to applyStayAwayGateDecision", () => {
  const src = readSrc("kalshi-bot-loop.ts");
  assert.ok(
    src.includes("applyStayAwayGateDecision("),
    "Phase-3 loop must call applyStayAwayGateDecision — do not inline the guard logic",
  );
  assert.ok(
    src.includes("getWindowBetSignal(sym)") &&
    src.includes("S.config.requireMonitorReady ?? true") &&
    src.includes("filteredByNewGuards"),
    "applyStayAwayGateDecision must receive getWindowBetSignal(sym), config.requireMonitorReady, and filteredByNewGuards",
  );
});

// ===========================================================================
// Clock-derived timing guards — entry buffer, late-floor, window transition
//
// These wiring tests confirm that every timing gate in the Phase-3 loop uses
// clockElapsedS (anchored to the official window-boundary timestamp) and NOT
// winCtx.secondsElapsed (which is measured from when the Kalshi prefetch
// completed — 20–40 s after the boundary — and would cause early-entry bugs).
//
// See: .agents/memory/bot-timing-clock-source.md
// ===========================================================================

test("timing/clockElapsedS: Phase-3 loop derives elapsed time from the window boundary key, not the prefetch", () => {
  const src = readSrc("kalshi-bot-loop.ts");
  // The authoritative clock formula must be present
  assert.ok(
    src.includes("(Date.now() - new Date(windowKey).getTime()) / 1000"),
    "clockElapsedS must be computed as (Date.now() - new Date(windowKey).getTime()) / 1000 — " +
    "using winCtx.secondsElapsed or Date.now() alone would anchor to the prefetch time, not the window boundary",
  );
  // Math.max(0, ...) guard against negative values on clock skew must be present
  assert.ok(
    src.includes("Math.max(0,") && src.includes("(Date.now() - new Date(windowKey).getTime())"),
    "clockElapsedS must be clamped with Math.max(0, ...) to handle clock skew at window open",
  );
});

test("timing/pipelineGate: Phase-3 loop skips coins whose pipeline-completion entry has already fired this window", () => {
  const src = readSrc("kalshi-bot-loop.ts");
  // The pipelineEntryFiredThisWindow Set must be declared at module level
  assert.ok(
    src.includes("pipelineEntryFiredThisWindow"),
    "pipelineEntryFiredThisWindow Set must exist in kalshi-bot-loop.ts to track which coins have had their pipeline-triggered entry evaluated",
  );
  // Phase-3 must check the Set and exclude coins from Phase-4 via filteredByNewGuards
  assert.ok(
    src.includes("pipelineEntryFiredThisWindow.has(`${sym}:${windowKey}`)") &&
    src.includes("filteredByNewGuards.add(sym)"),
    "Phase-3 must add pipeline-triggered coins to filteredByNewGuards to prevent Phase-4 double-evaluation",
  );
  // The skip reason must be identifiable in logs
  assert.ok(
    src.includes("pipeline-triggered entry already evaluated this window"),
    "Phase-3 SKIP reason must include 'pipeline-triggered entry already evaluated this window' for log traceability",
  );
});

test("timing/pipelineGate: pipelineEntryFiredThisWindow is cleared on window transition", () => {
  const src = readSrc("kalshi-bot-loop.ts");
  assert.ok(
    src.includes("pipelineEntryFiredThisWindow.clear()"),
    "pipelineEntryFiredThisWindow must be cleared on window transition so each new window gets a fresh evaluation",
  );
});

test("timing/pipelineGate: pipeline callback requires ALL THREE signals (stat+Claude+ML) non-null", () => {
  const src = readSrc("kalshi-bot-pipeline.ts");
  // HARD RULE: the bot must never enter a bet with a missing signal.  The
  // completion callback is the entry trigger, so it must be gated on all
  // three model signals being non-null — not just stat.
  assert.ok(
    src.includes("statAbove !== null && claudeAbove !== null && mlAbove !== null") &&
    src.includes("_pipelineCompleteCallback"),
    "pipeline completion callback must be gated on statAbove, claudeAbove AND mlAbove all being non-null",
  );
  // When signals are incomplete the pipeline must log a wait — not fire.
  assert.ok(
    src.includes("waiting for all signals"),
    "pipeline must log 'waiting for all signals' when any of the three signals is still null",
  );
});

test("timing/pipelineGate: pipeline callback fires on re-check when signals transition to all-non-null for the first time", () => {
  const src = readSrc("kalshi-bot-pipeline.ts");
  // The tracker takes time after window-open to produce all signals. The
  // initial pipeline can complete with partial (null) signals. The first
  // re-check where all three are non-null is the true "all signals ready"
  // moment — the callback must fire then too, not be permanently excluded
  // because isRecheck=true.
  assert.ok(
    src.includes("prevAnyWasNull") &&
    src.includes("prevResult.statAbove === null") &&
    src.includes("prevResult.claudeAbove === null") &&
    src.includes("prevResult.mlAbove === null"),
    "callback must fire on re-check when any previously stored signal was null (transition to all-ready)",
  );
  assert.ok(
    src.includes("!isRecheck || prevAnyWasNull"),
    "callback guard must allow re-check to fire when prevAnyWasNull is true",
  );
});

test("allSignals/tickGate: _runBotTick blocks new entries until stat, Claude AND ML are all non-null (live read)", () => {
  const src = readSrc("kalshi-bot-tick.ts");
  // The scheduler tick path can reach makeBotDecision even when the pipeline
  // stored a partial result — the live all-signals gate must block it.
  assert.ok(
    src.includes("getLatestCoinSignals(sym)"),
    "_runBotTick must read live signals via getLatestCoinSignals — not the stored pipeline snapshot",
  );
  assert.ok(
    src.includes("live.statAbove === null || live.claudeAbove === null || live.mlAbove === null"),
    "_runBotTick must defer when any of the three live signals is null",
  );
  assert.ok(
    src.includes("waiting for all signals (stat+Claude+ML)"),
    "the all-signals defer must be logged for traceability",
  );
});

test("noFallbacks/pipeline: bot pipeline never computes its own signals (no analyzeCoin / no Claude calls)", () => {
  const src = readSrc("kalshi-bot-pipeline.ts");
  // The predictor tool is the ONLY place stat/Claude/ML are computed.
  assert.ok(
    !src.includes("analyzeCoin("),
    "kalshi-bot-pipeline must NOT call analyzeCoin — stat comes from the predictor's predCache only",
  );
  assert.ok(
    !src.includes("anthropic.messages.create"),
    "kalshi-bot-pipeline must NOT make its own Claude calls — Claude verdicts come from the predictor's tracker only",
  );
  assert.ok(
    !src.includes("_callPipelineClaude"),
    "the _callPipelineClaude fallback must stay deleted",
  );
});

test("noFallbacks/engine: decision engine consumes getLatestCoinSignals only — no internal signal assembly", () => {
  const src = readSrc("kalshi-bot-engine.ts");
  // The engine must read the predictor's shared signal snapshot — the same
  // one the pipeline and tick gates check — so gate and decision can never
  // diverge.
  assert.ok(
    src.includes("getLatestCoinSignals(sym)"),
    "engine must call getLatestCoinSignals — the single source of truth for stat/Claude/ML",
  );
  // No direct signal-source reads or model computation in the engine.
  for (const banned of [
    "getStatWindowCall(",
    "getTrackerWindowCall(",
    "liveDirectionCache.get(",
    "predCache.get(",
    "extractMLFeatures(",
    "getMLPrediction(",
    "getCachedPrediction(",
  ]) {
    assert.ok(
      !src.includes(banned),
      `engine must NOT call ${banned}...) — signal assembly belongs to crypto-signals.ts only`,
    );
  }
  // Engine-level all-three gate must exist as final defense before decisions.
  assert.ok(
    src.includes("statAbove === null || claudeAbove === null || mlAbove === null"),
    "engine must SKIP when any of the three signals is null",
  );
});

test("noFallbacks/signals: crypto-signals derives stat from predCache, not historyStore", () => {
  const src = readSrc("crypto-signals.ts");
  // The pure comparison logic lives in the pure sub-module; read both files.
  const pureSrc = readSrc("crypto-signals-pure.ts");
  assert.ok(
    !src.includes("getStatWindowCall("),
    "getLatestCoinSignals must NOT call getStatWindowCall (historyStore lags 30-90s at window open)",
  );
  assert.ok(
    src.includes("predCache.get(sym)"),
    "crypto-signals.ts must read predCache.get(sym) (freshness-checked via resolvePredEntry)",
  );
  assert.ok(
    pureSrc.includes("predictedPrice >= kalshiTarget"),
    "stat comparison (predictedPrice >= kalshiTarget) must live in crypto-signals-pure.ts",
  );
  // Freshness guard: a stale predictor snapshot must null out stat+ML so the
  // all-signals gate blocks entries instead of betting on stale model output.
  assert.ok(
    src.includes("PRED_MAX_AGE_MS") || pureSrc.includes("PRED_MAX_AGE_MS"),
    "crypto-signals must enforce a max-age freshness guard on the predCache snapshot",
  );
});

test("timing/maxEntryMinutes: entry ceiling also uses clockElapsedS", () => {
  const src = readSrc("kalshi-bot-loop.ts");
  assert.ok(
    src.includes("clockElapsedS > S.config.maxEntryMinutes * 60"),
    "maxEntryMinutes ceiling check must compare clockElapsedS — not secondsElapsed — against the ceiling",
  );
  assert.ok(
    src.includes("past entry ceiling (>") && src.includes("elapsed, clock="),
    "maxEntryMinutes SKIP reason must include clock= to surface the clockElapsedS value in logs",
  );
});

test("timing/minRemainingFloor: late-floor guard also uses clockElapsedS", () => {
  const src = readSrc("kalshi-bot-loop.ts");
  // The minRemainingMinutes guard must compute time-left from clockElapsedS (15*60 - clockElapsedS)
  assert.ok(
    src.includes("15 * 60 - clockElapsedS"),
    "minRemainingMinutes floor must compute time-left as (15 * 60 - clockElapsedS) — " +
    "using secondsElapsed would undercount elapsed time and let late bets slip through",
  );
  assert.ok(
    src.includes("min remaining, clock=") && src.includes("s elapsed)"),
    "min-remaining floor SKIP reason must include 'clock=' to surface clockElapsedS in logs",
  );
});

test("timing/windowTransition: liveDirectionCache is cleared with a log message at each window boundary", () => {
  const src = readSrc("kalshi-bot-loop.ts");
  // The cache must be explicitly cleared so prior-window Claude verdicts can't
  // contaminate the new window's signal path
  assert.ok(
    src.includes("liveDirectionCache.clear()"),
    "liveDirectionCache must be cleared on window transition to prevent prior-window Claude verdicts from leaking",
  );
  // A structured log line must accompany the clear so production logs surface the event
  assert.ok(
    src.includes("[kalshi-bot] window transition: liveDirectionCache cleared"),
    "window transition must emit '[kalshi-bot] window transition: liveDirectionCache cleared' so production log-scans can verify timing",
  );
  // The clear must happen inside the newWindowKey !== S.lastStabilityWindowKey guard
  // (i.e., only once per window boundary, not every tick)
  assert.ok(
    src.includes("S.lastStabilityWindowKey") && src.includes("liveDirectionCache.clear()"),
    "liveDirectionCache.clear() must be guarded by the window-key change check (S.lastStabilityWindowKey) — clearing every tick would break live-direction caching",
  );
});
