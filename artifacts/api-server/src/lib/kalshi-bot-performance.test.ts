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
  QUIET_HOURS_MIN_BETS,
  QUIET_HOURS_MIN_BETS_PER_DAY,
  QUIET_HOURS_MIN_BAD_DAYS,
  PER_MARKET_QUIET_HOURS_MIN_BETS,
  computeSymbolQuietHoursV2,
  mergeCalibratedSymbolQuietHours,
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
    byHourBandDow: {},
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

/**
 * Build byHourBandDow entries for a band with `numBadDays` days each showing
 * a poor win rate (wins=3, losses=7 per day → 30% WR) and `numGoodDays` days
 * each showing a good win rate (wins=8, losses=2 → 80% WR).
 * Each day gets QUIET_HOURS_MIN_BETS_PER_DAY bets so it qualifies for the check.
 */
function makeBandDow(
  band: string,
  numBadDays: number,
  numGoodDays = 0,
): Record<string, Record<number, { wins: number; losses: number; betCount: number; winRate: number | null }>> {
  const dowEntry: Record<number, { wins: number; losses: number; betCount: number; winRate: number | null }> = {};
  for (let d = 0; d < numBadDays; d++) {
    // 3 wins / 7 losses per day = 30% win rate, betCount = QUIET_HOURS_MIN_BETS_PER_DAY
    const n = QUIET_HOURS_MIN_BETS_PER_DAY;
    const wins = Math.round(n * 0.3);
    const losses = n - wins;
    dowEntry[d] = { wins, losses, betCount: n, winRate: wins / n };
  }
  for (let d = numBadDays; d < numBadDays + numGoodDays; d++) {
    const n = QUIET_HOURS_MIN_BETS_PER_DAY;
    const wins = Math.round(n * 0.8);
    const losses = n - wins;
    dowEntry[d] = { wins, losses, betCount: n, winRate: wins / n };
  }
  return { [band]: dowEntry };
}

test("runAutoTuneRules returns empty when enableAutoTuning=false", () => {
  const report = makeReport({ totalBets: 50, last30WinRate: 0.40 });
  const config = { ...DEFAULT_CONFIG, enableAutoTuning: false };
  const mutations = runAutoTuneRules(report, config, new Map());
  assert.equal(mutations.length, 0);
});

test(`rule1: quiet_hours_expand fires when band has ≥${QUIET_HOURS_MIN_BETS} bets, <40% WR, and bad on ≥${QUIET_HOURS_MIN_BAD_DAYS} days`, () => {
  const report = makeReport({
    byHourBand: {
      "14-16": { band: "14-16", wins: 45, losses: 105, betCount: QUIET_HOURS_MIN_BETS, winRate: 0.3 },
    },
    byHourBandDow: makeBandDow("14-16", QUIET_HOURS_MIN_BAD_DAYS),
  });
  const mutations = runAutoTuneRules(report, DEFAULT_CONFIG, new Map());
  const r1 = mutations.find(m => m.ruleName === "quiet_hours_expand");
  assert.ok(r1, "quiet_hours_expand mutation should be present");
  assert.ok(r1.triggerReason.includes("14-16"), "reason should mention the band");
  assert.ok(r1.triggerReason.includes("days"), "reason should mention days of the week");
  assert.ok(r1.configMutation, "configMutation should be set so the rule is applied");
  // DEFAULT_CONFIG quietHoursEnd=8, band end=16 → new end=16; start stays 2
  assert.equal(r1.configMutation!.quietHoursStart, 2);
  assert.equal(r1.configMutation!.quietHoursEnd, 16);
});

test("rule1: quiet_hours_expand skips band already inside quiet window", () => {
  // Config quiet hours 02-08; band 04-06 is fully inside — should not expand even with enough data
  const report = makeReport({
    byHourBand: {
      "04-06": { band: "04-06", wins: 45, losses: 105, betCount: QUIET_HOURS_MIN_BETS, winRate: 0.3 },
    },
    byHourBandDow: makeBandDow("04-06", QUIET_HOURS_MIN_BAD_DAYS),
  });
  const mutations = runAutoTuneRules(report, DEFAULT_CONFIG, new Map());
  const r1 = mutations.find(m => m.ruleName === "quiet_hours_expand");
  assert.equal(r1, undefined, "should not expand when band is already quiet");
});

test(`rule1: skips band with fewer than ${QUIET_HOURS_MIN_BETS} bets`, () => {
  const report = makeReport({
    byHourBand: {
      "14-16": { band: "14-16", wins: 3, losses: 16, betCount: QUIET_HOURS_MIN_BETS - 1, winRate: 0.16 },
    },
    byHourBandDow: makeBandDow("14-16", QUIET_HOURS_MIN_BAD_DAYS),
  });
  const mutations = runAutoTuneRules(report, DEFAULT_CONFIG, new Map());
  const r1 = mutations.find(m => m.ruleName === "quiet_hours_expand");
  assert.equal(r1, undefined, `fewer than ${QUIET_HOURS_MIN_BETS} bets should not trigger rule`);
});

test(`rule1: skips band with ≥${QUIET_HOURS_MIN_BETS} bets but bad pattern on fewer than ${QUIET_HOURS_MIN_BAD_DAYS} days`, () => {
  const report = makeReport({
    byHourBand: {
      "14-16": { band: "14-16", wins: 45, losses: 105, betCount: QUIET_HOURS_MIN_BETS, winRate: 0.3 },
    },
    // Only 2 bad days — one short of the required 3
    byHourBandDow: makeBandDow("14-16", QUIET_HOURS_MIN_BAD_DAYS - 1),
  });
  const mutations = runAutoTuneRules(report, DEFAULT_CONFIG, new Map());
  const r1 = mutations.find(m => m.ruleName === "quiet_hours_expand");
  assert.equal(r1, undefined,
    `rule1 must not fire when bad pattern appears on fewer than ${QUIET_HOURS_MIN_BAD_DAYS} days`);
});

test("rule2: per_coin_pause is DISABLED — does not fire even on ≥5 consecutive losses", () => {
  // Rule 2 was removed because per-coin pausing is now handled exclusively by
  // applyStreakUpdate (kalshi-bot-guards.ts) which enforces window adjacency.
  // The old report-based rule had no adjacency check.
  const report = makeReport({
    bySymbol: {
      BTC: { wins: 10, losses: 10, betCount: 20, winRate: 0.5, currentConsecutiveLosses: 5 },
    },
  });
  const mutations = runAutoTuneRules(report, DEFAULT_CONFIG, new Map());
  const r2 = mutations.find(m => m.ruleName === "per_coin_pause");
  assert.equal(r2, undefined, "per_coin_pause rule is disabled — should never fire");
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

test("rule3: confidence_floor_raise is capped at 70", () => {
  const report = makeReport({ totalBets: 40, last30WinRate: 0.40 });
  const config = { ...DEFAULT_CONFIG, minConfidence: 68 };
  const mutations = runAutoTuneRules(report, config, new Map());
  const r3 = mutations.find(m => m.ruleName === "confidence_floor_raise");
  assert.ok(r3);
  assert.equal(r3.configMutation?.minConfidence, 70);
});

test("rule3: confidence_floor_raise does not fire when already at 70", () => {
  const report = makeReport({ totalBets: 40, last30WinRate: 0.40 });
  const config = { ...DEFAULT_CONFIG, minConfidence: 70 };
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

test("active rules can fire simultaneously (rule1 + rule3; rule2 disabled)", () => {
  // Rule 2 (per_coin_pause) is disabled — only rule1 and rule3 should fire.
  const report = makeReport({
    totalBets: 50,
    last30WinRate: 0.45,
    bySymbol: {
      BTC: { wins: 0, losses: 5, betCount: 5, winRate: 0, currentConsecutiveLosses: 5 },
    },
    byHourBand: {
      "20-22": { band: "20-22", wins: 45, losses: 105, betCount: QUIET_HOURS_MIN_BETS, winRate: 0.3 },
    },
    byHourBandDow: makeBandDow("20-22", QUIET_HOURS_MIN_BAD_DAYS),
  });
  const mutations = runAutoTuneRules(report, DEFAULT_CONFIG, new Map());
  assert.ok(mutations.find(m => m.ruleName === "quiet_hours_expand"), "rule1 must still fire");
  assert.equal(mutations.find(m => m.ruleName === "per_coin_pause"), undefined, "rule2 must NOT fire (disabled)");
  assert.ok(mutations.find(m => m.ruleName === "confidence_floor_raise"), "rule3 must still fire");
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

/**
 * Like makeBetsInBand but puts bets on a specific UTC date (YYYY-MM-DD).
 * Used to spread bets across multiple days of the week for DOW tests.
 */
function makeBetsInBandOnDate(
  hour: number, wins: number, losses: number, symbol: string, date: string,
): ReturnType<typeof makeBet>[] {
  const hh = String(hour).padStart(2, "0");
  const exitedAt = `${date}T${hh}:30:00Z`;
  return [
    ...Array.from({ length: wins },  () => makeBet({ symbol, outcome: "win",  exitedAt })),
    ...Array.from({ length: losses }, () => makeBet({ symbol, outcome: "loss", exitedAt })),
  ];
}

test("realistic 150-bet session: rule1 does NOT fire — band has only 40 bets (below 150-bet minimum)", () => {
  // 14-16 band gets 40 bets at ~32% WR — bad rate but way below QUIET_HOURS_MIN_BETS=150
  // 10-12 band gets 47 bets at ~76% WR — also below minimum, and rate is good
  // Rule 1 must remain silent for both bands.
  const bets = [
    ...makeBetsInBand(15, 7, 18, "BTC"),   // 14-16: 25 bets, 28% win
    ...makeBetsInBand(15, 6, 9, "ETH"),    // 14-16: +15 bets → total 40 bets, 32.5% win
    ...makeBetsInBand(11, 16, 6, "ETH"),   // 10-12: 22 bets, 72.7% win
    ...makeBetsInBand(11, 20, 5, "BTC"),   // 10-12: +25 bets → total 47 bets, 76.6% win
  ];

  const report = computePerformanceReport(bets, NOW);

  const band1416 = report.byHourBand["14-16"];
  assert.ok(band1416, "14-16 band must exist");
  assert.ok(band1416.betCount < QUIET_HOURS_MIN_BETS,
    `14-16 band should be below ${QUIET_HOURS_MIN_BETS}, got ${band1416.betCount}`);

  const mutations = runAutoTuneRules(report, DEFAULT_CONFIG, new Map());
  const r1 = mutations.find(m => m.ruleName === "quiet_hours_expand");
  assert.equal(r1, undefined,
    `rule1 must not fire: 40 bets in 14-16 is far below the ${QUIET_HOURS_MIN_BETS}-bet minimum`);
});

test(`realistic session: rule1 fires when band reaches ${QUIET_HOURS_MIN_BETS} bets across ≥${QUIET_HOURS_MIN_BAD_DAYS} bad days, not for good band`, () => {
  // 14-16 band: 50 bets × 3 days = 150 bets total, 30% WR each day (3 bad days) → should fire
  // 10-12 band: 50 bets × 1 day = 50 bets, 76% WR → not bad
  // Bets on Thu 2026-01-15, Fri 2026-01-16, Sat 2026-01-17
  const bets = [
    ...makeBetsInBandOnDate(15, 15, 35, "BTC", "2026-01-15"), // Thu: 50 bets, 30% WR
    ...makeBetsInBandOnDate(15, 15, 35, "ETH", "2026-01-16"), // Fri: 50 bets, 30% WR
    ...makeBetsInBandOnDate(15, 15, 35, "BTC", "2026-01-17"), // Sat: 50 bets, 30% WR
    ...makeBetsInBandOnDate(11, 38, 12, "ETH", "2026-01-15"), // 10-12: 50 bets, 76% WR
  ];

  const report = computePerformanceReport(bets, NOW);

  const band1416 = report.byHourBand["14-16"];
  assert.ok(band1416, "14-16 band must exist");
  assert.equal(band1416.betCount, 150, `14-16 band should have 150 bets`);
  assert.ok((band1416.winRate ?? 1) < 0.40,
    `14-16 band win rate should be <40%, got ${band1416.winRate}`);

  const bandDow1416 = report.byHourBandDow["14-16"];
  assert.ok(bandDow1416, "byHourBandDow must have 14-16 entry");
  const badDays = Object.values(bandDow1416).filter(
    d => d.betCount >= QUIET_HOURS_MIN_BETS_PER_DAY && (d.winRate ?? 1) < 0.4,
  );
  assert.ok(badDays.length >= QUIET_HOURS_MIN_BAD_DAYS,
    `must have ≥${QUIET_HOURS_MIN_BAD_DAYS} bad DOW entries, got ${badDays.length}`);

  const mutations = runAutoTuneRules(report, DEFAULT_CONFIG, new Map());
  const r1 = mutations.find(m => m.ruleName === "quiet_hours_expand");
  assert.ok(r1, "quiet_hours_expand should fire for the bad 14-16 band");
  assert.ok(r1.triggerReason.includes("14-16"), "trigger reason should cite 14-16");
  assert.ok(r1.triggerReason.includes("days"), "trigger reason should mention days");
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

test(`edge case: only 1 hour band populated with <${QUIET_HOURS_MIN_BETS} bets — rule1 must NOT fire`, () => {
  // 18 bets all in the 10-12 band with a terrible 11% win rate
  // Quiet window is 02-08, so 10-12 is outside and would normally be a candidate.
  // However 18 << 150-bet minimum so rule1 must stay silent.
  const bets = makeBetsInBand(11, 2, 16, "BTC"); // 18 bets, 11.1% win rate
  assert.equal(bets.length, 18);

  const report = computePerformanceReport(bets, NOW);
  assert.equal(Object.keys(report.byHourBand).length, 1, "exactly one band should exist");
  assert.equal(report.byHourBand["10-12"]?.betCount, 18);

  const mutations = runAutoTuneRules(report, DEFAULT_CONFIG, new Map());
  const r1 = mutations.find(m => m.ruleName === "quiet_hours_expand");
  assert.equal(r1, undefined,
    `rule1 must not fire — only 18 bets in that band, below the ${QUIET_HOURS_MIN_BETS}-bet minimum`);
});

test(`edge case: exactly ${QUIET_HOURS_MIN_BETS} bets on ${QUIET_HOURS_MIN_BAD_DAYS} bad days fires rule1`, () => {
  // Exactly QUIET_HOURS_MIN_BETS (150) bets spread across 3 days, each with 50 bets.
  // Each day is bad (30% WR) so all 3 qualify. Rule1 must fire.
  const perDay = QUIET_HOURS_MIN_BETS / QUIET_HOURS_MIN_BAD_DAYS; // 50
  const wins = Math.round(perDay * 0.3);
  const losses = perDay - wins;
  const bets = [
    ...makeBetsInBandOnDate(15, wins, losses, "BTC", "2026-01-15"), // Thu
    ...makeBetsInBandOnDate(15, wins, losses, "BTC", "2026-01-16"), // Fri
    ...makeBetsInBandOnDate(15, wins, losses, "BTC", "2026-01-17"), // Sat
  ];
  assert.equal(bets.length, QUIET_HOURS_MIN_BETS);

  const report = computePerformanceReport(bets, NOW);
  assert.equal(report.byHourBand["14-16"]?.betCount, QUIET_HOURS_MIN_BETS);

  const mutations = runAutoTuneRules(report, DEFAULT_CONFIG, new Map());
  const r1 = mutations.find(m => m.ruleName === "quiet_hours_expand");
  assert.ok(r1, `rule1 should fire at exactly ${QUIET_HOURS_MIN_BETS} bets with ${QUIET_HOURS_MIN_BAD_DAYS} bad days`);
});

test(`edge case: ${QUIET_HOURS_MIN_BETS - 1} bets (one below threshold) must NOT fire rule1`, () => {
  // QUIET_HOURS_MIN_BETS - 1 total bets across 3 bad days — just one bet short.
  // Rule1 must not fire.
  const report = makeReport({
    byHourBand: {
      "14-16": {
        band: "14-16",
        wins: 40,
        losses: QUIET_HOURS_MIN_BETS - 1 - 40,
        betCount: QUIET_HOURS_MIN_BETS - 1,
        winRate: 40 / (QUIET_HOURS_MIN_BETS - 1),
      },
    },
    byHourBandDow: makeBandDow("14-16", QUIET_HOURS_MIN_BAD_DAYS),
  });
  const mutations = runAutoTuneRules(report, DEFAULT_CONFIG, new Map());
  const r1 = mutations.find(m => m.ruleName === "quiet_hours_expand");
  assert.equal(r1, undefined,
    `rule1 must not fire at ${QUIET_HOURS_MIN_BETS - 1} bets — one below the minimum`);
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

test("edge case: consecutive losses across symbols — auto-tune no longer triggers per-coin pauses (rule2 disabled)", () => {
  // Rule 2 (per_coin_pause) is disabled — per-coin pausing is now handled exclusively
  // by applyStreakUpdate in kalshi-bot-guards.ts with window-adjacency enforcement.
  // This test confirms the performance report still correctly tracks streaks, but
  // auto-tune never generates a pauseCoin mutation regardless of streak length.
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
  assert.equal(report.bySymbol["BTC"]?.currentConsecutiveLosses, 5,
    "report still tracks streak for observability");
  assert.equal(report.bySymbol["ETH"]?.currentConsecutiveLosses, 0,
    "ETH streak should be 0 after the win reset");

  const mutations = runAutoTuneRules(report, DEFAULT_CONFIG, new Map());
  const pauses = mutations.filter(m => m.ruleName === "per_coin_pause");
  assert.equal(pauses.length, 0, "rule2 is disabled — no pauseCoin mutations must be generated");
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

test(`threshold boundary: two bad bands at 149 and 150 bets — only the 150-bet band qualifies, and only if DOW check passes`, () => {
  // Band 18-20: QUIET_HOURS_MIN_BETS - 1 bets, terrible WR — does NOT qualify (one below threshold)
  // Band 14-16: QUIET_HOURS_MIN_BETS bets, terrible WR, 3 bad days — DOES qualify
  const report = makeReport({
    byHourBand: {
      "18-20": {
        band: "18-20",
        wins: 30,
        losses: QUIET_HOURS_MIN_BETS - 1 - 30,
        betCount: QUIET_HOURS_MIN_BETS - 1,
        winRate: 30 / (QUIET_HOURS_MIN_BETS - 1),
      },
      "14-16": {
        band: "14-16",
        wins: 45,
        losses: 105,
        betCount: QUIET_HOURS_MIN_BETS,
        winRate: 0.3,
      },
    },
    byHourBandDow: {
      // 18-20 has only 2 bad days (one short) → DOW check fails even if bets were enough
      ...makeBandDow("18-20", QUIET_HOURS_MIN_BAD_DAYS - 1),
      // 14-16 has 3 bad days → DOW check passes
      ...makeBandDow("14-16", QUIET_HOURS_MIN_BAD_DAYS),
    },
  });

  const mutations = runAutoTuneRules(report, DEFAULT_CONFIG, new Map());
  const r1 = mutations.find(m => m.ruleName === "quiet_hours_expand");
  assert.ok(r1, "rule1 should fire for the 14-16 band (meets both thresholds)");
  assert.ok(r1.triggerReason.includes("14-16"),
    "trigger reason must cite 14-16, not the under-threshold 18-20 band");
});

test("per-market Smart Hours uses three settled bets as the shared calibration minimum", () => {
  assert.equal(PER_MARKET_QUIET_HOURS_MIN_BETS, 3);
});

test("per-market Smart Hours puts every zero-history cell in data gathering", () => {
  const schedule = computeSymbolQuietHoursV2([], 85);
  for (let dow = 0; dow < 7; dow++) {
    assert.deepEqual(schedule.silencedByDow?.[String(dow)], []);
    assert.deepEqual(
      schedule.dataGatheringByDow?.[String(dow)],
      Array.from({ length: 24 }, (_, hour) => hour),
    );
  }
});

test("per-market Smart Hours keeps cells with one or two bets in data gathering", () => {
  const createdAt = "2026-08-17T15:15:00.000Z"; // Monday ET, UTC hour 15
  for (const count of [1, 2]) {
    const bets = Array.from({ length: count }, () =>
      makeBet({ createdAt, outcome: "loss" }));
    const schedule = computeSymbolQuietHoursV2(bets, 85);
    assert.equal(schedule.dataGatheringByDow?.["1"]?.includes(15), true);
    assert.equal(schedule.silencedByDow?.["1"]?.includes(15), false);
  }
});

test("per-market Smart Hours allows the third settled bet to calibrate the cell", () => {
  const createdAt = "2026-08-17T15:15:00.000Z"; // Monday ET, UTC hour 15
  const bets = Array.from({ length: 3 }, () =>
    makeBet({ createdAt, outcome: "loss" }));
  const schedule = computeSymbolQuietHoursV2(bets, 85);
  assert.equal(schedule.dataGatheringByDow?.["1"]?.includes(15), false);
  assert.equal(schedule.silencedByDow?.["1"]?.includes(15), true);
});

test("per-market Smart Hours strictly follows the selected silence-below threshold", () => {
  const createdAt = "2026-08-17T15:15:00.000Z"; // Monday ET, UTC hour 15
  const atThreshold = [
    makeBet({ createdAt, outcome: "win" }),
    makeBet({ createdAt, outcome: "win" }),
    makeBet({ createdAt, outcome: "loss" }),
    makeBet({ createdAt, outcome: "loss" }),
  ];
  const belowThreshold = [
    makeBet({ createdAt, outcome: "win" }),
    makeBet({ createdAt, outcome: "loss" }),
    makeBet({ createdAt, outcome: "loss" }),
    makeBet({ createdAt, outcome: "loss" }),
  ];

  const exact = computeSymbolQuietHoursV2(atThreshold, 50);
  assert.equal(
    exact.silencedByDow?.["1"]?.includes(15),
    false,
    "win rate equal to the selected threshold must remain active",
  );

  const below = computeSymbolQuietHoursV2(belowThreshold, 50);
  assert.equal(
    below.silencedByDow?.["1"]?.includes(15),
    true,
    "win rate below the selected threshold must be silenced",
  );
});

test("per-market recalibration preserves manual percentage and dollar limits", () => {
  const current = {
    enabled: true,
    silencedUtcHours: [],
    reducedBetUtcHours: {},
    silencedByDow: { "1": [10] },
    dataGatheringByDow: { "1": [15, 16] },
    reducedByDow: { "1": { "11": 40 } },
    dataGatheringOverrides: {
      "1": {
        "15": { type: "percent" as const, pct: 25 },
        "16": { type: "dollar" as const, amount: 2 },
      },
    },
    calibratedAt: "2026-08-19T14:00:00.000Z",
  };
  const calibrated = {
    enabled: true,
    silencedUtcHours: [],
    reducedBetUtcHours: {},
    silencedByDow: { "1": [] },
    dataGatheringByDow: { "1": [16] },
    calibratedAt: "2026-08-19T15:00:00.000Z",
  };

  const merged = mergeCalibratedSymbolQuietHours(current, calibrated);
  assert.deepEqual(merged.silencedByDow, calibrated.silencedByDow);
  assert.deepEqual(merged.dataGatheringByDow, calibrated.dataGatheringByDow);
  assert.deepEqual(merged.reducedByDow, current.reducedByDow);
  assert.deepEqual(merged.dataGatheringOverrides, current.dataGatheringOverrides);
  assert.equal(merged.calibratedAt, calibrated.calibratedAt);
});

test("forceEnable calibration enables a disabled symbol (auto == manual enablement parity)", () => {
  const current = {
    enabled: false, // operator-disabled symbol
    silencedUtcHours: [],
    reducedBetUtcHours: {},
    silencedByDow: { "1": [10] },
    dataGatheringByDow: { "1": [15, 16] },
    reducedByDow: { "1": { "11": 40 } },
    dataGatheringOverrides: {
      "1": { "16": { type: "dollar" as const, amount: 2 } },
    },
    autoTuneEnabled: false, // operator restriction that must survive
    calibratedAt: "2026-08-19T14:00:00.000Z",
  };
  const calibrated = {
    enabled: true,
    silencedUtcHours: [],
    reducedBetUtcHours: {},
    silencedByDow: { "1": [] },
    dataGatheringByDow: { "1": [16] },
    autoTuneEnabled: true, // calibration hard-codes true — must NOT override operator's false
    calibratedAt: "2026-08-19T15:00:00.000Z",
  };

  // Default (no forceEnable): stored enabled:false is preserved.
  const preserved = mergeCalibratedSymbolQuietHours(current, calibrated);
  assert.equal(preserved.enabled, false);

  // forceEnable:true → enabled flips to true, exactly like the manual button.
  const forced = mergeCalibratedSymbolQuietHours(current, calibrated, true);
  assert.equal(forced.enabled, true);
  // Operator-owned fields still preserved under forceEnable.
  assert.equal(forced.autoTuneEnabled, false);
  assert.deepEqual(forced.reducedByDow, current.reducedByDow);
  assert.deepEqual(forced.dataGatheringOverrides, current.dataGatheringOverrides);
  // Calibration still owns the classification + timestamp.
  assert.deepEqual(forced.silencedByDow, calibrated.silencedByDow);
  assert.deepEqual(forced.dataGatheringByDow, calibrated.dataGatheringByDow);
  assert.equal(forced.calibratedAt, calibrated.calibratedAt);
});
