// Unit tests for the pure performance-analytics + auto-tune functions.
//
// Run with:  pnpm --filter @workspace/api-server test
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computePerformanceReport,
  runAutoTuneRules,
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
// runAutoTuneRules
// ---------------------------------------------------------------------------

function makeReport(overrides: Partial<PerformanceReport> = {}): PerformanceReport {
  return {
    totalBets: 0,
    wins: 0,
    losses: 0,
    overallWinRate: null,
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
