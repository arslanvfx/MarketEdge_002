import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createBoundedScalpShadowWriter,
  buildScalpShadowStudyReport,
  evaluateScalpShadowEntry,
  settleScalpShadowRecord,
} from "./kalshi-scalper-shadow.ts";
import {
  DEFAULT_SCALP_CONFIG,
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
      ...shadowRecord("ETH"),
      variantSeconds: 105 as const,
      settlementResult: null,
      outcome: null,
      hypotheticalPnl: null,
    };
    const report = buildScalpShadowStudyReport("live", [settled, open105], {
      configuredWindowSeconds: 80.1234,
      effectiveWindowSecondsBySymbol: { BTC: 80.1234, ETH: 105 },
      trackingSince: "2026-08-23T16:00:00.000Z",
    });
    assert.deepEqual(
      report.variants.map((variant) => variant.variantSeconds),
      [60, 75, 80.1234, 90, 105, 120],
    );
    assert.equal(report.variants.find((row) => row.variantSeconds === 120)?.wins, 1);
    assert.equal(report.variants.find((row) => row.variantSeconds === 105)?.settled, 0);
    assert.equal(report.variants.find((row) => row.variantSeconds === 60)?.observed, 0);
    assert.equal(report.configuredWindowSeconds, 80.1234);
    assert.equal(report.effectiveWindowSecondsBySymbol.ETH, 105);
    assert.equal(report.trackingSince, "2026-08-23T16:00:00.000Z");
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