// Unit tests for the pure performance-analytics + auto-tune functions.
//
// Run with:  pnpm --filter @workspace/api-server test
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computePerformanceReport,
  runAutoTuneRules,
  mergeQuietWindow,
  decrementPausedCoins,
  CONFIDENCE_FLOOR_COOLDOWN_MS,
  type SettledBetRecord,
  type PerformanceReport,
  type AutoTuneBotConfig,
} from "./kalshi-bot-performance.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = new Date("2026-01-15T12:00:00Z");

function makeBet(overrides: Partial<SettledBetRecord> = {}): SettledBetRecord {
  return {
    symbol: "BTC",
    direction: "yes",
    pnl: "1.50",
    exitReason: "mid_exit_phase1",
    createdAt: "2026-01-15T10:00:00Z",
    exitedAt: "2026-01-15T10:14:00Z",
    signals: null,
    outcome: "win",
    ...overrides,
  };
}

const DEFAULT_CONFIG: AutoTuneBotConfig = {
  minConfidence: 60,
  quietHoursStart: 2,
  quietHoursEnd: 8,
  enableAutoTuning: true,
  defaultMinConfidence: 60,
};

// ---------------------------------------------------------------------------
// computePerformanceReport
// ---------------------------------------------------------------------------

test("empty input returns zeroed report", () => {
  const report = computePerformanceReport([], NOW);
  assert.equal(report.totalBets, 0);
  assert.equal(report.wins, 0);
  assert.equal(report.losses, 0);
  assert.equal(report.overallWinRate, null);
  assert.equal(report.last30WinRate, null);
  assert.deepEqual(report.bySymbol, {});
  assert.deepEqual(report.byHourBand, {});
  assert.equal(report.recommendations.length, 0);
});

test("push outcomes are excluded from settled count", () => {
  const bets = [
    makeBet({ outcome: "win" }),
    makeBet({ outcome: "loss" }),
    makeBet({ outcome: "push" }),
    makeBet({ outcome: null }),
  ];
  const report = computePerformanceReport(bets, NOW);
  assert.equal(report.totalBets, 2);
  assert.equal(report.wins, 1);
  assert.equal(report.losses, 1);
});

test("overallWinRate computed correctly", () => {
  const bets = [
    makeBet({ outcome: "win" }),
    makeBet({ outcome: "win" }),
    makeBet({ outcome: "loss" }),
  ];
  const report = computePerformanceReport(bets, NOW);
  assert.equal(report.totalBets, 3);
  assert.ok(Math.abs((report.overallWinRate ?? 0) - 2 / 3) < 1e-9);
});

test("last30WinRate uses last 30 bets only", () => {
  // 35 losses then 30 wins
  const bets = [
    ...Array.from({ length: 35 }, () => makeBet({ outcome: "loss" })),
    ...Array.from({ length: 30 }, () => makeBet({ outcome: "win" })),
  ];
  const report = computePerformanceReport(bets, NOW);
  // last30 = all 30 wins
  assert.equal(report.last30WinRate, 1.0);
  // overall = 30 wins / 65 total
  assert.ok(Math.abs((report.overallWinRate ?? 0) - 30 / 65) < 1e-9);
});

test("last24hWinRate only counts recent bets", () => {
  const cutoff = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);
  const oldTime = new Date(cutoff.getTime() - 3600_000).toISOString();
  const newTime = new Date(NOW.getTime() - 3600_000).toISOString();

  const bets = [
    makeBet({ outcome: "loss", exitedAt: oldTime }),
    makeBet({ outcome: "win", exitedAt: newTime }),
    makeBet({ outcome: "win", exitedAt: newTime }),
  ];
  const report = computePerformanceReport(bets, NOW);
  assert.ok(report.last24hWinRate !== null);
  assert.equal(report.last24hWinRate, 1.0); // 2 wins in the last 24h
});

test("bySymbol groups and computes win rates correctly", () => {
  const bets = [
    makeBet({ symbol: "BTC", outcome: "win" }),
    makeBet({ symbol: "BTC", outcome: "loss" }),
    makeBet({ symbol: "ETH", outcome: "win" }),
    makeBet({ symbol: "ETH", outcome: "win" }),
  ];
  const report = computePerformanceReport(bets, NOW);
  assert.equal(report.bySymbol["BTC"]?.betCount, 2);
  assert.equal(report.bySymbol["BTC"]?.winRate, 0.5);
  assert.equal(report.bySymbol["ETH"]?.betCount, 2);
  assert.equal(report.bySymbol["ETH"]?.winRate, 1.0);
});

test("consecutive loss streak computed per symbol", () => {
  const bets = [
    makeBet({ symbol: "BTC", outcome: "win" }),
    makeBet({ symbol: "BTC", outcome: "loss" }),
    makeBet({ symbol: "BTC", outcome: "loss" }),
    makeBet({ symbol: "BTC", outcome: "loss" }),
  ];
  const report = computePerformanceReport(bets, NOW);
  assert.equal(report.bySymbol["BTC"]?.currentConsecutiveLosses, 3);
});

test("consecutive loss streak resets on a win", () => {
  const bets = [
    makeBet({ symbol: "ETH", outcome: "loss" }),
    makeBet({ symbol: "ETH", outcome: "loss" }),
    makeBet({ symbol: "ETH", outcome: "win" }),
  ];
  const report = computePerformanceReport(bets, NOW);
  assert.equal(report.bySymbol["ETH"]?.currentConsecutiveLosses, 0);
});

test("byHourBand groups by 2h UTC bands", () => {
  // exitedAt at 01:00 UTC → band "00-02"
  const bets = [
    makeBet({ outcome: "win", exitedAt: "2026-01-15T01:00:00Z" }),
    makeBet({ outcome: "loss", exitedAt: "2026-01-15T01:30:00Z" }),
    makeBet({ outcome: "win", exitedAt: "2026-01-15T13:00:00Z" }),
  ];
  const report = computePerformanceReport(bets, NOW);
  assert.equal(report.byHourBand["00-02"]?.betCount, 2);
  assert.equal(report.byHourBand["00-02"]?.winRate, 0.5);
  assert.equal(report.byHourBand["12-14"]?.betCount, 1);
  assert.equal(report.byHourBand["12-14"]?.winRate, 1.0);
});

test("byDirection splits yes/no correctly", () => {
  const bets = [
    makeBet({ direction: "yes", outcome: "win" }),
    makeBet({ direction: "yes", outcome: "loss" }),
    makeBet({ direction: "no", outcome: "win" }),
  ];
  const report = computePerformanceReport(bets, NOW);
  assert.equal(report.byDirection.yes.betCount, 2);
  assert.equal(report.byDirection.yes.winRate, 0.5);
  assert.equal(report.byDirection.no.betCount, 1);
  assert.equal(report.byDirection.no.winRate, 1.0);
});

test("avgConfidenceWinners and avgConfidenceLosers from signals", () => {
  const bets = [
    makeBet({ outcome: "win",  signals: { statConfidence: 80 } }),
    makeBet({ outcome: "win",  signals: { statConfidence: 60 } }),
    makeBet({ outcome: "loss", signals: { statConfidence: 55 } }),
  ];
  const report = computePerformanceReport(bets, NOW);
  assert.equal(report.avgConfidenceWinners, 70);
  assert.equal(report.avgConfidenceLosers, 55);
});

test("exitReasonBreakdown counts exit reasons", () => {
  const bets = [
    makeBet({ exitReason: "mid_exit_phase1", outcome: "win" }),
    makeBet({ exitReason: "mid_exit_phase1", outcome: "loss" }),
    makeBet({ exitReason: "time_stop", outcome: "loss" }),
  ];
  const report = computePerformanceReport(bets, NOW);
  assert.equal(report.exitReasonBreakdown["mid_exit_phase1"], 2);
  assert.equal(report.exitReasonBreakdown["time_stop"], 1);
});

// ---------------------------------------------------------------------------
// last10WinRate
// ---------------------------------------------------------------------------

test("last10WinRate uses only the last 10 bets", () => {
  // 25 losses followed by 10 wins → last10 is 100%, overall is 10/35
  const bets = [
    ...Array.from({ length: 25 }, () => makeBet({ outcome: "loss" })),
    ...Array.from({ length: 10 }, () => makeBet({ outcome: "win" })),
  ];
  const report = computePerformanceReport(bets, NOW);
  assert.equal(report.last10WinRate, 1.0);
  assert.ok(Math.abs((report.overallWinRate ?? 0) - 10 / 35) < 1e-9);
});

test("last10WinRate is null when no settled bets", () => {
  const report = computePerformanceReport([], NOW);
  assert.equal(report.last10WinRate, null);
});

// ---------------------------------------------------------------------------
// mergeQuietWindow
// ---------------------------------------------------------------------------

test("mergeQuietWindow extends end for non-wrapping window when band is after end", () => {
  // qS=2, qE=8; band [14-16) → extend end: fwd(8,16)=8 < fwd(14,2)=12
  const r = mergeQuietWindow(2, 8, 14, 16);
  assert.equal(r.quietHoursStart, 2);
  assert.equal(r.quietHoursEnd, 16);
});

test("mergeQuietWindow extends start for non-wrapping window when band is before start", () => {
  // qS=10, qE=18; band [2-4) → extend start: fwd(4,10)=6 > fwd(2,10)=8... wait
  // fwd(qE=18, bE=4) = (4-18+24)%24 = 10 → costEnd=10
  // fwd(bS=2, qS=10) = (10-2+24)%24 = 8 → costStart=8
  // costStart < costEnd → extend start: newStart = (10-8+24)%24 = 2
  const r = mergeQuietWindow(10, 18, 2, 4);
  assert.equal(r.quietHoursStart, 2);
  assert.equal(r.quietHoursEnd, 18);
});

test("mergeQuietWindow handles wrapping window (e.g. 22-06) extending end", () => {
  // qS=22, qE=4; band [4-6) → fwd(4,6)=2 < fwd(4,22)=18 → extend end
  const r = mergeQuietWindow(22, 4, 4, 6);
  assert.equal(r.quietHoursStart, 22);
  assert.equal(r.quietHoursEnd, 6);
});

test("mergeQuietWindow handles wrapping window (e.g. 22-06) extending start", () => {
  // qS=22, qE=4; band [20-22) → fwd(4,22)=18 > fwd(20,22)=2 → extend start
  const r = mergeQuietWindow(22, 4, 20, 22);
  assert.equal(r.quietHoursStart, 20);
  assert.equal(r.quietHoursEnd, 4);
});

// ---------------------------------------------------------------------------
// decrementPausedCoins
// ---------------------------------------------------------------------------

test("decrementPausedCoins decrements remaining windows by 1", () => {
  const input = new Map([["BTC", 4], ["ETH", 2]]);
  const result = decrementPausedCoins(input);
  assert.equal(result.get("BTC"), 3);
  assert.equal(result.get("ETH"), 1);
});

test("decrementPausedCoins removes coins whose countdown reaches 0", () => {
  const input = new Map([["BTC", 1], ["ETH", 3]]);
  const result = decrementPausedCoins(input);
  assert.equal(result.has("BTC"), false, "BTC should be removed when remaining=1");
  assert.equal(result.get("ETH"), 2);
});

test("decrementPausedCoins does not mutate the input map", () => {
  const input = new Map([["SOL", 2]]);
  decrementPausedCoins(input);
  assert.equal(input.get("SOL"), 2, "original map should be unchanged");
});

test("decrementPausedCoins returns empty map for empty input", () => {
  const result = decrementPausedCoins(new Map());
  assert.equal(result.size, 0);
});

// ---------------------------------------------------------------------------
// runAutoTuneRules
// ---------------------------------------------------------------------------

function makeReport(overrides: Partial<PerformanceReport> = {}): PerformanceReport {
  return {
    totalBets: 0,
    wins: 0,
    losses: 0,
    overallWinRate: null,
    last10WinRate: null,
    last30WinRate: null,
    last24hWinRate: null,
    bySymbol: {},
    byHourBand: {},
    byDirection: {
      yes: { wins: 0, losses: 0, betCount: 0, winRate: null },
      no: { wins: 0, losses: 0, betCount: 0, winRate: null },
    },
    avgConfidenceWinners: null,
    avgConfidenceLosers: null,
    exitReasonBreakdown: {},
    circuitBreakerTriggers: 0,
    recommendations: [],
    computedAt: NOW.toISOString(),
    ...overrides,
  };
}

test("runAutoTuneRules returns empty when enableAutoTuning=false", () => {
  const report = makeReport({ totalBets: 50, last30WinRate: 0.40 });
  const config = { ...DEFAULT_CONFIG, enableAutoTuning: false };
  const mutations = runAutoTuneRules(report, config, new Map());
  assert.equal(mutations.length, 0);
});

test("rule1: quiet_hours_expand fires when band has ≥20 bets and <40% win rate", () => {
  const report = makeReport({
    byHourBand: {
      "14-16": { band: "14-16", wins: 6, losses: 14, betCount: 20, winRate: 0.3 },
    },
  });
  const mutations = runAutoTuneRules(report, DEFAULT_CONFIG, new Map());
  const r1 = mutations.find(m => m.ruleName === "quiet_hours_expand");
  assert.ok(r1, "quiet_hours_expand mutation should be present");
  assert.ok(r1.triggerReason.includes("14-16"), "reason should mention the band");
  // configMutation must be present with expanded quiet window
  assert.ok(r1.configMutation, "configMutation should be set so the rule is applied");
  // DEFAULT_CONFIG quietHoursEnd=8, band end=16 → new end=16; start stays 2
  assert.equal(r1.configMutation!.quietHoursStart, 2);
  assert.equal(r1.configMutation!.quietHoursEnd, 16);
});

test("rule1: quiet_hours_expand skips band already inside quiet window", () => {
  // Config quiet hours 02-08; band 04-06 is fully inside
  const report = makeReport({
    byHourBand: {
      "04-06": { band: "04-06", wins: 5, losses: 15, betCount: 20, winRate: 0.25 },
    },
  });
  const mutations = runAutoTuneRules(report, DEFAULT_CONFIG, new Map());
  const r1 = mutations.find(m => m.ruleName === "quiet_hours_expand");
  assert.equal(r1, undefined, "should not expand when band is already quiet");
});

test("rule1: skips band with fewer than 20 bets", () => {
  const report = makeReport({
    byHourBand: {
      "14-16": { band: "14-16", wins: 3, losses: 16, betCount: 19, winRate: 0.16 },
    },
  });
  const mutations = runAutoTuneRules(report, DEFAULT_CONFIG, new Map());
  const r1 = mutations.find(m => m.ruleName === "quiet_hours_expand");
  assert.equal(r1, undefined, "fewer than 20 bets should not trigger rule");
});

test("rule2: per_coin_pause fires on ≥5 consecutive losses for a coin", () => {
  const report = makeReport({
    bySymbol: {
      BTC: { wins: 10, losses: 10, betCount: 20, winRate: 0.5, currentConsecutiveLosses: 5 },
    },
  });
  const mutations = runAutoTuneRules(report, DEFAULT_CONFIG, new Map());
  const r2 = mutations.find(m => m.ruleName === "per_coin_pause");
  assert.ok(r2, "per_coin_pause should fire");
  assert.equal(r2.pauseCoin?.symbol, "BTC");
  assert.equal(r2.pauseCoin?.windows, 4);
});

test("rule2: per_coin_pause skips coin that is already paused", () => {
  const report = makeReport({
    bySymbol: {
      BTC: { wins: 0, losses: 5, betCount: 5, winRate: 0, currentConsecutiveLosses: 5 },
    },
  });
  const paused = new Map([["BTC", 3]]);
  const mutations = runAutoTuneRules(report, DEFAULT_CONFIG, paused);
  const r2 = mutations.find(m => m.ruleName === "per_coin_pause");
  assert.equal(r2, undefined, "already-paused coin should not trigger another pause");
});

test("rule2: per_coin_pause does not fire for 4 consecutive losses", () => {
  const report = makeReport({
    bySymbol: {
      ETH: { wins: 5, losses: 4, betCount: 9, winRate: 0.55, currentConsecutiveLosses: 4 },
    },
  });
  const mutations = runAutoTuneRules(report, DEFAULT_CONFIG, new Map());
  const r2 = mutations.find(m => m.ruleName === "per_coin_pause");
  assert.equal(r2, undefined);
});

test("rule3: confidence_floor_raise fires when last30WinRate<55% and totalBets≥30", () => {
  const report = makeReport({ totalBets: 40, last30WinRate: 0.50 });
  const mutations = runAutoTuneRules(report, DEFAULT_CONFIG, new Map());
  const r3 = mutations.find(m => m.ruleName === "confidence_floor_raise");
  assert.ok(r3, "confidence_floor_raise should fire");
  assert.equal(r3.configMutation?.minConfidence, 65);
  assert.equal(r3.oldValue, "60");
  assert.equal(r3.newValue, "65");
});

test("rule3: confidence_floor_raise is capped at 80", () => {
  const report = makeReport({ totalBets: 40, last30WinRate: 0.40 });
  const config = { ...DEFAULT_CONFIG, minConfidence: 78 };
  const mutations = runAutoTuneRules(report, config, new Map());
  const r3 = mutations.find(m => m.ruleName === "confidence_floor_raise");
  assert.ok(r3);
  assert.equal(r3.configMutation?.minConfidence, 80);
});

test("rule3: confidence_floor_raise does not fire when already at 80", () => {
  const report = makeReport({ totalBets: 40, last30WinRate: 0.40 });
  const config = { ...DEFAULT_CONFIG, minConfidence: 80 };
  const mutations = runAutoTuneRules(report, config, new Map());
  const r3 = mutations.find(m => m.ruleName === "confidence_floor_raise");
  assert.equal(r3, undefined);
});

test("rule3: confidence_floor_raise does not fire when totalBets<30", () => {
  const report = makeReport({ totalBets: 29, last30WinRate: 0.40 });
  const mutations = runAutoTuneRules(report, DEFAULT_CONFIG, new Map());
  const r3 = mutations.find(m => m.ruleName === "confidence_floor_raise");
  assert.equal(r3, undefined);
});

test("rule3: does not fire when win rate is exactly 55%", () => {
  const report = makeReport({ totalBets: 40, last30WinRate: 0.55 });
  const mutations = runAutoTuneRules(report, DEFAULT_CONFIG, new Map());
  const r3 = mutations.find(m => m.ruleName === "confidence_floor_raise");
  assert.equal(r3, undefined);
});

test("circuitBreakerTriggers counts distinct CB-threshold crossings", () => {
  // 2 losses, 1 win, then 3 more losses → 1 trigger (streak=3)
  // then 1 win resets, then 4 losses → 1 more trigger at loss #3
  const bets = [
    makeBet({ outcome: "loss" }),
    makeBet({ outcome: "loss" }),
    makeBet({ outcome: "win" }),
    makeBet({ outcome: "loss" }),
    makeBet({ outcome: "loss" }),
    makeBet({ outcome: "loss" }), // streak hits 3 → trigger #1
    makeBet({ outcome: "loss" }), // continues streak, no double count
    makeBet({ outcome: "win" }),
    makeBet({ outcome: "loss" }),
    makeBet({ outcome: "loss" }),
    makeBet({ outcome: "loss" }), // streak hits 3 → trigger #2
  ];
  const report = computePerformanceReport(bets, NOW);
  assert.equal(report.circuitBreakerTriggers, 2);
});

test("circuitBreakerTriggers is zero when no streak reaches threshold", () => {
  const bets = [
    makeBet({ outcome: "loss" }),
    makeBet({ outcome: "loss" }),
    makeBet({ outcome: "win" }),
    makeBet({ outcome: "loss" }),
    makeBet({ outcome: "win" }),
  ];
  const report = computePerformanceReport(bets, NOW);
  assert.equal(report.circuitBreakerTriggers, 0);
});

test("all three rules can fire simultaneously", () => {
  const report = makeReport({
    totalBets: 50,
    last30WinRate: 0.45,
    bySymbol: {
      BTC: { wins: 0, losses: 5, betCount: 5, winRate: 0, currentConsecutiveLosses: 5 },
    },
    byHourBand: {
      "20-22": { band: "20-22", wins: 6, losses: 14, betCount: 20, winRate: 0.3 },
    },
  });
  const mutations = runAutoTuneRules(report, DEFAULT_CONFIG, new Map());
  assert.ok(mutations.find(m => m.ruleName === "quiet_hours_expand"));
  assert.ok(mutations.find(m => m.ruleName === "per_coin_pause"));
  assert.ok(mutations.find(m => m.ruleName === "confidence_floor_raise"));
});

// ---------------------------------------------------------------------------
// Cooldown tests (Rule 3 + Rule 4)
// ---------------------------------------------------------------------------

test("rule3: confidence_floor_raise is suppressed when within 6-hour cooldown", () => {
  const report = makeReport({ totalBets: 40, last30WinRate: 0.50 });
  const recentFire = new Date(NOW.getTime() - 2 * 60 * 60 * 1_000); // 2 hours ago
  const lastFiredAt = new Map([["confidence_floor_raise", recentFire]]);
  const mutations = runAutoTuneRules(report, DEFAULT_CONFIG, new Map(), lastFiredAt, NOW);
  const r3 = mutations.find(m => m.ruleName === "confidence_floor_raise");
  assert.equal(r3, undefined, "raise rule should be suppressed while on cooldown");
});

test("rule3: confidence_floor_raise fires after cooldown has elapsed", () => {
  const report = makeReport({ totalBets: 40, last30WinRate: 0.50 });
  const oldFire = new Date(NOW.getTime() - CONFIDENCE_FLOOR_COOLDOWN_MS - 60_000); // just expired
  const lastFiredAt = new Map([["confidence_floor_raise", oldFire]]);
  const mutations = runAutoTuneRules(report, DEFAULT_CONFIG, new Map(), lastFiredAt, NOW);
  const r3 = mutations.find(m => m.ruleName === "confidence_floor_raise");
  assert.ok(r3, "raise rule should fire once cooldown has elapsed");
});

test("rule4: confidence_floor_lower fires when win rate > 70% and floor above default", () => {
  const report = makeReport({ totalBets: 40, last30WinRate: 0.75 });
  const config = { ...DEFAULT_CONFIG, minConfidence: 70 }; // raised above default 60
  const mutations = runAutoTuneRules(report, config, new Map(), new Map(), NOW);
  const r4 = mutations.find(m => m.ruleName === "confidence_floor_lower");
  assert.ok(r4, "confidence_floor_lower should fire");
  assert.equal(r4.configMutation?.minConfidence, 65);
  assert.equal(r4.oldValue, "70");
  assert.equal(r4.newValue, "65");
});

test("rule4: confidence_floor_lower does not fire when floor equals default", () => {
  const report = makeReport({ totalBets: 40, last30WinRate: 0.80 });
  const mutations = runAutoTuneRules(report, DEFAULT_CONFIG, new Map(), new Map(), NOW);
  const r4 = mutations.find(m => m.ruleName === "confidence_floor_lower");
  assert.equal(r4, undefined, "lower rule should not fire when floor is already at default");
});

test("rule4: confidence_floor_lower does not fire when win rate is exactly 70%", () => {
  const report = makeReport({ totalBets: 40, last30WinRate: 0.70 });
  const config = { ...DEFAULT_CONFIG, minConfidence: 70 };
  const mutations = runAutoTuneRules(report, config, new Map(), new Map(), NOW);
  const r4 = mutations.find(m => m.ruleName === "confidence_floor_lower");
  assert.equal(r4, undefined, "lower rule requires strictly > 70%");
});

test("rule4: confidence_floor_lower does not fire when raise rule is on cooldown", () => {
  // If raise fired recently, lower should also be blocked (cross-cooldown guard)
  const report = makeReport({ totalBets: 40, last30WinRate: 0.75 });
  const config = { ...DEFAULT_CONFIG, minConfidence: 70 };
  const recentFire = new Date(NOW.getTime() - 1 * 60 * 60 * 1_000); // 1 hour ago
  const lastFiredAt = new Map([["confidence_floor_raise", recentFire]]);
  const mutations = runAutoTuneRules(report, config, new Map(), lastFiredAt, NOW);
  const r4 = mutations.find(m => m.ruleName === "confidence_floor_lower");
  assert.equal(r4, undefined, "lower rule blocked when raise is on cooldown");
});

test("rule4: confidence_floor_lower does not fire when lower rule itself is on cooldown", () => {
  const report = makeReport({ totalBets: 40, last30WinRate: 0.75 });
  const config = { ...DEFAULT_CONFIG, minConfidence: 70 };
  const recentFire = new Date(NOW.getTime() - 3 * 60 * 60 * 1_000); // 3 hours ago
  const lastFiredAt = new Map([["confidence_floor_lower", recentFire]]);
  const mutations = runAutoTuneRules(report, config, new Map(), lastFiredAt, NOW);
  const r4 = mutations.find(m => m.ruleName === "confidence_floor_lower");
  assert.equal(r4, undefined, "lower rule blocked by its own cooldown");
});

test("rule4: lower rule floors at defaultMinConfidence (never below default)", () => {
  const report = makeReport({ totalBets: 40, last30WinRate: 0.80 });
  const config = { ...DEFAULT_CONFIG, minConfidence: 63 }; // only 3 above default
  const mutations = runAutoTuneRules(report, config, new Map(), new Map(), NOW);
  const r4 = mutations.find(m => m.ruleName === "confidence_floor_lower");
  assert.ok(r4, "lower rule should fire");
  assert.equal(r4.configMutation?.minConfidence, 60, "should floor at defaultMinConfidence");
});

// ---------------------------------------------------------------------------
// Realistic-volume validation (100–200 synthetic bets)
// ---------------------------------------------------------------------------

/**
 * Build a batch of bets all exiting within a given UTC hour.
 * Returns `wins` win records followed by `losses` loss records.
 */
function makeBetsInBand(
  utcHour: number,
  wins: number,
  losses: number,
  symbol = "BTC",
): SettledBetRecord[] {
  const pad = (n: number) => String(n).padStart(2, "0");
  const exitedAt = `2026-01-15T${pad(utcHour)}:30:00Z`;
  const out: SettledBetRecord[] = [];
  for (let i = 0; i < wins; i++) out.push(makeBet({ symbol, outcome: "win", exitedAt }));
  for (let i = 0; i < losses; i++) out.push(makeBet({ symbol, outcome: "loss", exitedAt }));
  return out;
}

test("realistic 150-bet session: rule1 fires for bad band, not for good band", () => {
  // Band 14-16: 40 bets, ~32% win rate (bad) → rule 1 should fire
  // Band 10-12: 47 bets, ~76% win rate (good) → rule 1 should NOT fire
  // Remaining bands below 20-bet threshold
  const bets = [
    ...makeBetsInBand(15, 7, 18, "BTC"),   // 14-16: 25 bets, 28% win
    ...makeBetsInBand(15, 6, 9, "ETH"),    // 14-16: +15 bets, 40% win → total 40 bets, 32.5% win
    ...makeBetsInBand(11, 16, 6, "ETH"),   // 10-12: 22 bets, 72.7% win
    ...makeBetsInBand(11, 20, 5, "BTC"),   // 10-12: +25 bets → total 47 bets, 76.6% win
    ...makeBetsInBand(9,  8,  7, "BTC"),   // 08-10: 15 bets (below threshold)
    ...makeBetsInBand(21, 5,  5, "SOL"),   // 20-22: 10 bets (below threshold)
    ...Array.from({ length: 8 }, () =>     // loose bets in 06-08 (already in quiet window)
      makeBet({ outcome: "win", exitedAt: "2026-01-15T07:30:00Z" })),
  ];
  // Total: 40+47+15+10+8 = 120 bets; add 30 more scattered wins to reach ~150
  const extra = Array.from({ length: 30 }, () =>
    makeBet({ outcome: "win", exitedAt: "2026-01-15T13:30:00Z" })); // 12-14 band
  const allBets = [...bets, ...extra];
  assert.ok(allBets.length >= 100, `need ≥100 bets, got ${allBets.length}`);

  const report = computePerformanceReport(allBets, NOW);

  const band1416 = report.byHourBand["14-16"];
  assert.ok(band1416, "14-16 band must exist");
  assert.ok(band1416.betCount >= 20, `14-16 band needs ≥20 bets, got ${band1416.betCount}`);
  assert.ok((band1416.winRate ?? 1) < 0.40,
    `14-16 band win rate should be <40%, got ${band1416.winRate}`);

  const band1012 = report.byHourBand["10-12"];
  assert.ok(band1012, "10-12 band must exist");
  assert.ok(band1012.betCount >= 20, `10-12 band needs ≥20 bets, got ${band1012.betCount}`);
  assert.ok((band1012.winRate ?? 0) > 0.60,
    `10-12 band win rate should be >60%, got ${band1012.winRate}`);

  const mutations = runAutoTuneRules(report, DEFAULT_CONFIG, new Map());
  const r1 = mutations.find(m => m.ruleName === "quiet_hours_expand");
  assert.ok(r1, "quiet_hours_expand should fire for the bad 14-16 band");
  assert.ok(r1.triggerReason.includes("14-16"), "trigger reason should cite 14-16");
});

test("realistic 150-bet session: rule3 fires when last-30 win rate is genuinely poor", () => {
  // 120 wins (oldest) then 30 consecutive losses → last30 = 0% win rate
  const bets = [
    ...Array.from({ length: 120 }, () => makeBet({ outcome: "win" })),
    ...Array.from({ length: 30 }, () => makeBet({ outcome: "loss" })),
  ];
  const report = computePerformanceReport(bets, NOW);
  assert.equal(report.totalBets, 150);
  assert.equal(report.last30WinRate, 0);

  const mutations = runAutoTuneRules(report, DEFAULT_CONFIG, new Map());
  const r3 = mutations.find(m => m.ruleName === "confidence_floor_raise");
  assert.ok(r3, "confidence_floor_raise should fire with 150 bets and 0% last-30 win rate");
  assert.equal(r3.configMutation?.minConfidence, 65);
});

test("edge case: only 1 hour band populated with <20 bets — rule1 must NOT fire", () => {
  // 18 bets all in the 10-12 band with a terrible 11% win rate
  // Quiet window is 02-08, so 10-12 is outside and would normally be a candidate
  const bets = makeBetsInBand(11, 2, 16, "BTC"); // 18 bets, 11.1% win rate
  assert.equal(bets.length, 18);

  const report = computePerformanceReport(bets, NOW);
  assert.equal(Object.keys(report.byHourBand).length, 1, "exactly one band should exist");
  assert.equal(report.byHourBand["10-12"]?.betCount, 18);

  const mutations = runAutoTuneRules(report, DEFAULT_CONFIG, new Map());
  const r1 = mutations.find(m => m.ruleName === "quiet_hours_expand");
  assert.equal(r1, undefined,
    "rule1 must not fire — only 18 bets in that band, below the 20-bet minimum");
});

test("edge case: only 1 hour band populated, fires at exactly 20 bets", () => {
  // Same scenario but bumped to exactly 20 bets — now the rule should fire
  const bets = makeBetsInBand(15, 6, 14, "BTC"); // 20 bets, 30% win rate (in 14-16 band)
  assert.equal(bets.length, 20);

  const report = computePerformanceReport(bets, NOW);
  assert.equal(report.byHourBand["14-16"]?.betCount, 20);

  const mutations = runAutoTuneRules(report, DEFAULT_CONFIG, new Map());
  const r1 = mutations.find(m => m.ruleName === "quiet_hours_expand");
  assert.ok(r1, "rule1 should fire at exactly 20 bets");
});

test("edge case: consecutive losses cross symbol boundaries — per-coin pause must not fire", () => {
  // Each coin has losses, but none individually reaches 5 consecutive losses.
  // BTC streak=3, ETH streak=3, SOL streak=2.
  // The per-coin logic must NOT treat these as a combined streak.
  const bets = [
    makeBet({ symbol: "BTC", outcome: "win" }),
    makeBet({ symbol: "BTC", outcome: "loss" }),
    makeBet({ symbol: "BTC", outcome: "loss" }),
    makeBet({ symbol: "BTC", outcome: "loss" }),  // BTC streak=3
    makeBet({ symbol: "ETH", outcome: "win" }),
    makeBet({ symbol: "ETH", outcome: "loss" }),
    makeBet({ symbol: "ETH", outcome: "loss" }),
    makeBet({ symbol: "ETH", outcome: "loss" }),  // ETH streak=3
    makeBet({ symbol: "SOL", outcome: "win" }),
    makeBet({ symbol: "SOL", outcome: "loss" }),
    makeBet({ symbol: "SOL", outcome: "loss" }),  // SOL streak=2
  ];

  const report = computePerformanceReport(bets, NOW);
  assert.equal(report.bySymbol["BTC"]?.currentConsecutiveLosses, 3, "BTC streak should be 3");
  assert.equal(report.bySymbol["ETH"]?.currentConsecutiveLosses, 3, "ETH streak should be 3");
  assert.equal(report.bySymbol["SOL"]?.currentConsecutiveLosses, 2, "SOL streak should be 2");

  const mutations = runAutoTuneRules(report, DEFAULT_CONFIG, new Map());
  const r2 = mutations.find(m => m.ruleName === "per_coin_pause");
  assert.equal(r2, undefined,
    "per_coin_pause must not fire — no individual coin has ≥5 consecutive losses");
});

test("edge case: consecutive losses cross symbols — only the qualifying coin triggers pause", () => {
  // ETH has 4 losses then a win (streak resets to 0).
  // BTC then runs 5 straight losses.
  // Only BTC should be paused.
  const bets = [
    makeBet({ symbol: "ETH", outcome: "loss" }),
    makeBet({ symbol: "ETH", outcome: "loss" }),
    makeBet({ symbol: "ETH", outcome: "loss" }),
    makeBet({ symbol: "ETH", outcome: "loss" }),
    makeBet({ symbol: "ETH", outcome: "win" }), // resets ETH streak to 0
    makeBet({ symbol: "BTC", outcome: "loss" }),
    makeBet({ symbol: "BTC", outcome: "loss" }),
    makeBet({ symbol: "BTC", outcome: "loss" }),
    makeBet({ symbol: "BTC", outcome: "loss" }),
    makeBet({ symbol: "BTC", outcome: "loss" }), // BTC streak=5
  ];

  const report = computePerformanceReport(bets, NOW);
  assert.equal(report.bySymbol["BTC"]?.currentConsecutiveLosses, 5);
  assert.equal(report.bySymbol["ETH"]?.currentConsecutiveLosses, 0,
    "ETH streak should be 0 after the win reset");

  const mutations = runAutoTuneRules(report, DEFAULT_CONFIG, new Map());
  const pauses = mutations.filter(m => m.ruleName === "per_coin_pause");
  assert.equal(pauses.length, 1, "exactly one coin should be paused");
  assert.equal(pauses[0].pauseCoin?.symbol, "BTC", "BTC should be the paused coin");
});

test("edge case: all 200 bets are pushes — zero settled bets, no rules fire", () => {
  const bets = Array.from({ length: 200 }, () => makeBet({ outcome: "push" }));
  const report = computePerformanceReport(bets, NOW);

  assert.equal(report.totalBets, 0, "all pushes → zero settled bets");
  assert.equal(report.overallWinRate, null);
  assert.equal(report.last30WinRate, null);
  assert.deepEqual(report.byHourBand, {}, "no hour-band entries when no settled bets");
  assert.deepEqual(report.bySymbol, {}, "no symbol entries when no settled bets");

  const mutations = runAutoTuneRules(report, DEFAULT_CONFIG, new Map());
  assert.equal(mutations.length, 0,
    "no rules should fire when all 200 bets are pushes");
});

test("edge case: mixed pushes in 150-bet corpus — thresholds use settled count only", () => {
  // 30 losses + 90 wins + 30 pushes = 150 total, 120 settled
  // Losses are oldest so the last 30 settled are wins → last30WinRate = 100% (>55%)
  // All exit at 15:30 UTC → lands in 14-16 band
  const exitedAt = "2026-01-15T15:30:00Z";
  const bets = [
    ...Array.from({ length: 30 }, () => makeBet({ outcome: "loss", exitedAt })),
    ...Array.from({ length: 90 }, () => makeBet({ outcome: "win",  exitedAt })),
    ...Array.from({ length: 30 }, () => makeBet({ outcome: "push", exitedAt })),
  ];

  const report = computePerformanceReport(bets, NOW);
  assert.equal(report.totalBets, 120, "30 pushes excluded → 120 settled");

  const band = report.byHourBand["14-16"];
  assert.ok(band, "14-16 band should exist");
  assert.equal(band.betCount, 120, "band count reflects only settled bets");
  assert.ok(Math.abs((band.winRate ?? 0) - 0.75) < 1e-9,
    `expected 75% win rate, got ${band.winRate}`);

  const mutations = runAutoTuneRules(report, DEFAULT_CONFIG, new Map());
  // 75% win rate → rule1 should NOT fire (needs <40%)
  assert.equal(mutations.find(m => m.ruleName === "quiet_hours_expand"), undefined,
    "rule1 must not fire for a 75% win-rate band");
  // rule3 should NOT fire (75% > 55%)
  assert.equal(mutations.find(m => m.ruleName === "confidence_floor_raise"), undefined,
    "rule3 must not fire for a 75% overall win rate");
});

test("threshold boundary: 19-bet bad band skipped, adjacent 20-bet bad band fires", () => {
  // Band 18-20: 19 bets, ~26% win rate → below the 20-bet minimum, should NOT fire
  // Band 14-16: 20 bets, 30% win rate → meets the threshold, should fire
  const bets = [
    ...makeBetsInBand(19, 5, 14, "ETH"),  // 18-20: 19 bets, 26.3% win
    ...makeBetsInBand(15, 6, 14, "BTC"),  // 14-16: 20 bets, 30% win
  ];

  const report = computePerformanceReport(bets, NOW);
  assert.equal(report.byHourBand["18-20"]?.betCount, 19);
  assert.equal(report.byHourBand["14-16"]?.betCount, 20);

  const mutations = runAutoTuneRules(report, DEFAULT_CONFIG, new Map());
  const r1 = mutations.find(m => m.ruleName === "quiet_hours_expand");
  assert.ok(r1, "rule1 should fire for the 20-bet 14-16 band");
  // 18-20 has 19 bets so it doesn't qualify; 14-16 (30% win) is the worst qualifying band
  assert.ok(r1.triggerReason.includes("14-16"),
    "trigger reason must cite 14-16, not the 19-bet 18-20 band");
});
