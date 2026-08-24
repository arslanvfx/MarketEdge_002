import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createBoundedScalpShadowWriter,
  buildScalpShadowStudyReport,
  evaluateScalpShadowEntry,
  resolveScalpShadowVariantSeconds,
  resolveScalpShadowStudyScope,
  selectScalpShadowComparisonCohort,
  settleScalpShadowRecord,
  summarizeScalpShadowStudyRows,
} from "./kalshi-scalper-shadow.ts";
import {
  DEFAULT_SCALP_CONFIG,
  SCALP_SHADOW_VARIANT_SECONDS,
  type EffectiveScalpParams,
  type ScalpShadowStudyRecord,
} from "./kalshi-scalper-types.ts";

const closeMs = Date.parse("2026-08-23T16:15:00.000Z");
const closeTime = new Date(closeMs).toISOString();
const params: EffectiveScalpParams = {
  symbol: "BTC",
  ticker: "KXBTC15M-TEST",
  paused: false,
  bandMin: 0.96,
  bandMax: 0.99,
  finalWindowSeconds: 80,
  budgetDollars: 2,
};

function evaluate(nowMs: number, prices: number[]) {
  return evaluateScalpShadowEntry({
    nowMs,
    closeTime,
    expectedCloseTime: closeTime,
    variantSeconds: 120,
    ticker: params.ticker,
    yesAsk: 0.97,
    yesBid: 0.5,
    targetPrice: 100,
    samples: prices.map((price, index) => ({
      price,
      at: closeMs - 120_000 + index * 1_000,
    })),
    config: DEFAULT_SCALP_CONFIG,
    params,
  });
}

function shadowRecord(
  symbol = "BTC",
  update = "",
): ScalpShadowStudyRecord {
  return {
    mode: "live",
    windowKey: "2026-08-23T16:00",
    symbol,
    ticker: `T-${symbol}`,
    variantSeconds: 120,
    status: "candidate_found",
    firstEligibleAt: "2026-08-23T16:13:00.000Z",
    firstSafeEntryAt: "2026-08-23T16:13:04.000Z",
    firstSafeSecondsRemaining: 116,
    side: "yes",
    yesAsk: 0.97,
    noAsk: 0.5,
    winningAsk: 0.97,
    hypotheticalContracts: 2,
    hypotheticalBudget: 2,
    lastBlocker: update || null,
    blockerCounts: update ? { [update]: 1 } : {},
    entryEvidence: { counterfactualOnly: true },
    laterQuoteIssueObserved: false,
    laterQuoteIssueReason: null,
    settlementResult: null,
    outcome: null,
    hypotheticalPnl: null,
    createdAt: "2026-08-23T16:13:00.000Z",
    updatedAt: "2026-08-23T16:13:04.000Z",
    settledAt: null,
  };
}

describe("earlier-entry shadow guard parity", () => {
  it("warms from the variant boundary instead of borrowing older samples", () => {
    const warming = evaluate(closeMs - 118_000, [101, 102, 103]);
    assert.equal(warming.allowed, false);
    assert.equal(warming.blocker, "freefall_unavailable_warming");

    const ready = evaluate(closeMs - 116_000, [101, 102, 103, 104, 105]);
    assert.equal(ready.allowed, true);
    assert.equal(ready.blocker, null);
    assert.equal(ready.secondsRemaining, 116);
    assert.equal(ready.side, "yes");
  });

  it("anchors timing to the expected close even when cached identity is shifted", () => {
    const result = evaluateScalpShadowEntry({
      nowMs: closeMs - 116_000,
      closeTime: new Date(closeMs + 20_000).toISOString(),
      expectedCloseTime: closeTime,
      variantSeconds: 120,
      ticker: params.ticker,
      yesAsk: 0.97,
      yesBid: 0.5,
      targetPrice: 100,
      samples: [101, 102, 103, 104, 105].map((price, index) => ({
        price,
        at: closeMs - 120_000 + index * 1_000,
      })),
      config: DEFAULT_SCALP_CONFIG,
      params,
    });
    assert.equal(result.allowed, true);
    assert.equal(result.secondsRemaining, 116);
  });

  it("records an ineligible cached quote without treating it as a fill", () => {
    const result = evaluateScalpShadowEntry({
      nowMs: closeMs - 100_000,
      closeTime,
      expectedCloseTime: closeTime,
      variantSeconds: 120,
      ticker: params.ticker,
      yesAsk: 0.9,
      yesBid: 0.1,
      targetPrice: 100,
      samples: [],
      config: DEFAULT_SCALP_CONFIG,
      params,
    });
    assert.equal(result.allowed, false);
    assert.equal(result.blocker, "quote_outside_band");
  });
});

describe("shadow report projection", () => {
  it("reports every time-left comparison, selected timing, and excludes open rows from outcomes", () => {
    const settled = settleScalpShadowRecord(shadowRecord(), "yes");
    const open105 = {
      ...shadowRecord(),
      variantSeconds: 105 as const,
      settlementResult: null,
      outcome: null,
      hypotheticalPnl: null,
    };
    const report = buildScalpShadowStudyReport("live", [settled, open105], {
      configuredWindowSeconds: 80.1234,
      effectiveWindowSecondsBySymbol: { BTC: 80.1234, ETH: 105 },
      trackingSince: "2026-08-23T16:00:00.000Z",
      variantSeconds: [105, 120],
    });
    assert.deepEqual(
      report.variants.map((variant) => variant.variantSeconds),
      [105, 120],
    );
    assert.equal(report.variants.find((row) => row.variantSeconds === 120)?.wins, 1);
    assert.equal(report.variants.find((row) => row.variantSeconds === 105)?.settled, 0);
    assert.equal(report.variants.length, 2);
    assert.equal(report.configuredWindowSeconds, 80.1234);
    assert.equal(report.effectiveWindowSecondsBySymbol.ETH, 105);
    assert.equal(report.trackingSince, "2026-08-23T16:00:00.000Z");
    assert.equal(report.comparisonCoverage.sharedOpportunities, 1);
  });

  it("matches timing cards to the same production-shaped opportunity cohort", () => {
    const makeRow = (
      opportunity: number,
      variantSeconds: number,
      qualified: boolean,
    ): ScalpShadowStudyRecord => ({
      ...shadowRecord(),
      windowKey: `window-${opportunity}`,
      variantSeconds,
      firstSafeEntryAt: qualified
        ? "2026-08-23T16:13:04.000Z"
        : null,
      firstSafeSecondsRemaining: qualified ? variantSeconds - 4 : null,
      side: qualified ? "yes" : null,
      winningAsk: qualified ? 0.97 : null,
      hypotheticalContracts: qualified ? 2 : 0,
      status: qualified ? "candidate_found" : "closed_no_candidate",
    });
    const rows = Array.from({ length: 612 }, (_, opportunity) => [
      makeRow(
        opportunity,
        60,
        opportunity < 55 || (opportunity >= 227 && opportunity < 292),
      ),
      makeRow(
        opportunity,
        75,
        opportunity < 76 || (opportunity >= 227 && opportunity < 314),
      ),
      ...(opportunity < 227
        ? [makeRow(opportunity, 80, opportunity < 80)]
        : []),
    ]).flat();
    const raw = summarizeScalpShadowStudyRows(rows, [60, 75, 80]);
    assert.deepEqual(
      raw.map((summary) => [summary.observed, summary.candidates]),
      [[612, 120], [612, 163], [227, 80]],
    );

    const cohort = selectScalpShadowComparisonCohort(rows, [60, 75, 80]);
    const matched = summarizeScalpShadowStudyRows(
      cohort.rows,
      [60, 75, 80],
    );
    assert.deepEqual(
      matched.map((summary) => [summary.observed, summary.candidates]),
      [[227, 55], [227, 76], [227, 80]],
    );
    assert.deepEqual(cohort.coverage, {
      sharedOpportunities: 227,
      excludedIncompleteOpportunities: 385,
      coverageStart: "2026-08-23T16:13:00.000Z",
    });
  });

  it("observes global and override timings for every market", () => {
    const variants = resolveScalpShadowVariantSeconds({
      configuredWindowSeconds: 80,
      overrideWindowSeconds: [60, 77, 80, undefined],
    });
    assert.deepEqual(
      variants,
      [...SCALP_SHADOW_VARIANT_SECONDS, 77, 80].sort((a, b) => a - b),
    );
  });

  it("keeps an older loss in card totals after recent details are bounded", () => {
    const olderLoss = {
      ...settleScalpShadowRecord(shadowRecord("OLD"), "no"),
      createdAt: "2026-08-23T16:00:00.000Z",
      updatedAt: "2026-08-23T16:16:00.000Z",
    };
    const newerWins = Array.from({ length: 720 }, (_, index) => ({
      ...settleScalpShadowRecord(shadowRecord(`W${index}`), "yes"),
      createdAt: new Date(
        Date.parse("2026-08-23T17:00:00.000Z") + index * 1_000,
      ).toISOString(),
    }));
    const summary = summarizeScalpShadowStudyRows(
      [olderLoss, ...newerWins],
      [120],
    );
    const recentRows = newerWins.slice(-48);
    const report = buildScalpShadowStudyReport("live", recentRows, {
      variantSeconds: [120],
      variantSummaries: summary,
      recentRows,
      studyStartedAt: olderLoss.createdAt,
      scopeStart: olderLoss.createdAt,
      scopeEnd: "2026-08-23T18:00:00.000Z",
      actualComparison: {
        periodStart: olderLoss.createdAt,
        periodEnd: "2026-08-23T18:00:00.000Z",
        filledOrders: 2,
        settled: 2,
        wins: 1,
        losses: 1,
        winRate: 0.5,
        totalPnl: -1,
        totalSpent: 2,
      },
      actualOutsideShadowCoverage: {
        periodStart: "2026-08-23T15:00:00.000Z",
        periodEnd: olderLoss.createdAt,
        filledOrders: 1,
        settled: 1,
        wins: 0,
        losses: 1,
        winRate: 0,
        totalPnl: -1,
        totalSpent: 1,
      },
    });

    const timing = report.variants.find(
      (variant) => variant.variantSeconds === 120,
    );
    assert.equal(timing?.observed, 721);
    assert.equal(timing?.wins, 720);
    assert.equal(timing?.losses, 1);
    assert.equal(report.recent.length, 48);
    assert.equal(report.recent.some((row) => row.outcome === "loss"), false);
    assert.equal(report.actualComparison.losses, 1);
    assert.equal(report.actualOutsideShadowCoverage?.losses, 1);
  });

  it("aligns the comparison start to baseline, study coverage, and visual reset", () => {
    const performanceTrackingSince = new Date("2026-08-22T06:33:00.000Z");
    const studyStartedAt = new Date("2026-08-23T18:43:00.000Z");
    const scopeEnd = new Date("2026-08-24T08:00:00.000Z");
    const initial = resolveScalpShadowStudyScope({
      performanceTrackingSince,
      studyStartedAt,
      requestedTrackingSince: null,
      scopeEnd,
    });
    assert.equal(initial.scopeStart.toISOString(), studyStartedAt.toISOString());

    const resetAt = "2026-08-24T07:00:00.000Z";
    const reset = resolveScalpShadowStudyScope({
      performanceTrackingSince,
      studyStartedAt,
      requestedTrackingSince: resetAt,
      scopeEnd,
    });
    assert.equal(reset.scopeStart.toISOString(), resetAt);
    assert.equal(reset.scopeEnd.toISOString(), scopeEnd.toISOString());
  });

  it("separates full-scope SQL totals from bounded UI detail rows", () => {
    const dbSource = readFileSync(
      new URL("./kalshi-scalper-db.ts", import.meta.url),
      "utf8",
    );
    const aggregateStart = dbSource.indexOf(
      "export async function getScalpShadowStudyVariantSummaries",
    );
    const recentStart = dbSource.indexOf(
      "export async function getRecentScalpShadowStudies",
    );
    assert.ok(aggregateStart >= 0 && recentStart > aggregateStart);
    const aggregateSource = dbSource.slice(aggregateStart, recentStart);
    assert.match(aggregateSource, /GROUP BY variant_seconds/);
    assert.match(aggregateSource, /complete_cohort/);
    assert.match(aggregateSource, /COUNT\(DISTINCT variant_seconds\)/);
    assert.doesNotMatch(aggregateSource, /\bLIMIT\b/);

    const panelSource = readFileSync(
      new URL(
        "../../../market-edge/src/pages/bot/bot-scalper-panel.tsx",
        import.meta.url,
      ),
      "utf8",
    );
    assert.match(panelSource, /shadowStudyData\.scopeStart/);
    assert.match(panelSource, /shadowStudyData\.scopeEnd/);
    assert.match(panelSource, /shadowStudyData\.actualComparison\.losses/);
    assert.match(panelSource, /actualOutsideShadowCoverage/);
    assert.match(panelSource, /comparisonCoverage\.sharedOpportunities/);
  });
});

describe("shadow settlement economics", () => {
  it("maps YES and NO outcomes using real contract economics", () => {
    const yesWin = settleScalpShadowRecord(
      shadowRecord(),
      "yes",
      "2026-08-23T16:16:00.000Z",
    );
    assert.equal(yesWin.outcome, "win");
    assert.ok(Math.abs((yesWin.hypotheticalPnl ?? 0) - 0.06) < 1e-9);

    const noEntry = {
      ...shadowRecord("ETH"),
      side: "no" as const,
      winningAsk: 0.97,
      yesAsk: 0.5,
      noAsk: 0.97,
    };
    const noLoss = settleScalpShadowRecord(noEntry, "yes");
    assert.equal(noLoss.outcome, "loss");
    assert.ok(Math.abs((noLoss.hypotheticalPnl ?? 0) + 1.94) < 1e-9);
  });
});

describe("bounded shadow persistence isolation", () => {
  it("coalesces pending rows and drops overflow instead of blocking", async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const delivered: ScalpShadowStudyRecord[] = [];
    let writes = 0;
    const writer = createBoundedScalpShadowWriter(async (record) => {
      writes += 1;
      if (writes === 1) await firstBlocked;
      delivered.push(record);
    }, 2);

    assert.equal(writer.record(shadowRecord("BTC")), true);
    assert.equal(writer.record(shadowRecord("ETH", "old")), true);
    assert.equal(writer.record(shadowRecord("ETH", "latest")), true);
    assert.equal(writer.record(shadowRecord("SOL")), true);
    assert.equal(writer.record(shadowRecord("XRP")), false);

    releaseFirst();
    while (writer.pending() > 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.equal(delivered.length, 3);
    assert.equal(
      delivered.find((record) => record.symbol === "ETH")?.lastBlocker,
      "latest",
    );
  });

  it("cannot import any live execution or persistence boundary", () => {
    const source = readFileSync(
      new URL("./kalshi-scalper-shadow.ts", import.meta.url),
      "utf8",
    );
    for (const forbidden of [
      "kalshi-scalper-db",
      "kalshi-scalper-exchange",
      "kalshi-scalper-service",
      "kalshi-trader",
    ]) {
      assert.equal(
        source.includes(`from "./${forbidden}`),
        false,
        `shadow evaluator imports forbidden boundary ${forbidden}`,
      );
    }
  });
});