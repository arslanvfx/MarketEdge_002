// ---------------------------------------------------------------------------
// kalshi-scalper-policy.test.ts — Unit tests for kalshi-scalper-policy.ts
// Run with: node --experimental-strip-types --test
// ---------------------------------------------------------------------------

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  selectScalpSide,
  computeContractCount,
  computeLimitPrice,
  winningCostFromFill,
  computeScalpPnl,
  isFillWithinBand,
  classifyScalpFillAgainstBand,
  isInFinalWindow,
  resolveTimingPhase,
  secondsUntilEligible,
  checkFreefallGuard,
  evaluateFreefallPreSubmitGuard,
  checkTargetProximityGuard,
  resolveScalpMarketState,
  checkDailyCap,
  checkOpenCap,
  evaluateCapDecision,
  classifyPlaceOrderResult,
  parseScalpOrderResponse,
  buildExecutionRiskSnapshot,
  compareRiskSnapshot,
  maxSubmitExposure,
  sizeOrderWithinReservedBudget,
  validateOrderbookQuote,
  validateScalpConfigPartial,
  parseScalpConfigPatch,
  describeScalpCircuitBreakerReason,
  preserveNewerScalpBreakerState,
  persistCircuitBreakerWithPolicy,
  resolveEffectiveParams,
  evaluateScalpReservationRetry,
  SCALP_AUTH_RETRY_COOLDOWN_MS,
  SCALP_BALANCE_RETRY_COOLDOWN_MS,
  SCALP_GUARD_RETRY_COOLDOWN_MS,
  SCALP_MAX_SUBMISSIONS_PER_WINDOW,
  SCALP_PREFLIGHT_LEAD_SECONDS,
  type FreefallSample,
  type RiskConfigLike,
  type RiskParamsLike,
} from "./kalshi-scalper-policy.ts";
import {
  DEFAULT_SCALP_CONFIG,
  DEFAULT_SCALP_OPEN_CAP_DOLLARS,
  normalizeScalpOpenCapDollars,
} from "./kalshi-scalper-types.ts";

// ---------------------------------------------------------------------------
// selectScalpSide — canonical price model
// ---------------------------------------------------------------------------

describe("selectScalpSide", () => {
  const band = { min: 0.91, max: 0.98 };

  it("selects YES when yesAsk is in band", () => {
    const result = selectScalpSide(0.95, 0.12, band.min, band.max);
    assert.ok(result, "should return a result");
    assert.equal(result.side, "yes");
    assert.equal(result.winningAsk, 0.95);
  });

  it("selects NO when noAsk is in band and yesAsk is not", () => {
    // e.g. yesAsk=0.05 (cheap YES → expensive NO): noAsk = 1 - yesBid
    // Here noAsk=0.93 passes band check directly
    const result = selectScalpSide(0.05, 0.93, band.min, band.max);
    assert.ok(result, "should return a result");
    assert.equal(result.side, "no");
    assert.equal(result.winningAsk, 0.93);
  });

  it("does NOT complement noAsk before band check — noAsk=0.05 is out-of-band", () => {
    // noAsk=0.05 (cheap NO), yesAsk=0.95 (in band) → selects YES, not NO
    const result = selectScalpSide(0.95, 0.05, band.min, band.max);
    assert.ok(result, "should return YES since yesAsk=0.95 is in band");
    assert.equal(result.side, "yes");
    assert.equal(result.winningAsk, 0.95);
  });

  it("returns null when neither ask is in band", () => {
    const result = selectScalpSide(0.50, 0.50, band.min, band.max);
    assert.equal(result, null);
  });

  it("returns null when only noAsk is also out of band", () => {
    // Both out of band
    const result = selectScalpSide(0.10, 0.10, band.min, band.max);
    assert.equal(result, null);
  });

  it("selects YES at exact band boundary", () => {
    const r1 = selectScalpSide(0.91, null, band.min, band.max);
    assert.ok(r1); assert.equal(r1.side, "yes"); assert.equal(r1.winningAsk, 0.91);
    const r2 = selectScalpSide(0.98, null, band.min, band.max);
    assert.ok(r2); assert.equal(r2.side, "yes"); assert.equal(r2.winningAsk, 0.98);
  });

  it("handles null asks gracefully", () => {
    assert.equal(selectScalpSide(null, null, band.min, band.max), null);
    assert.equal(selectScalpSide(null, 0.93, band.min, band.max)?.side, "no");
  });

  it("canonical NO example: yesAsk=0.05, noAsk=0.93 → side=no, winningAsk=0.93", () => {
    // yesBid ≈ 0.07 → noAsk = 1 - yesBid = 0.93
    const result = selectScalpSide(0.05, 0.93, 0.91, 0.98);
    assert.ok(result);
    assert.equal(result.side, "no");
    assert.equal(result.winningAsk, 0.93);
  });
});

// ---------------------------------------------------------------------------
// computeLimitPrice — YES-side limit price for placeOrder
// ---------------------------------------------------------------------------

describe("computeLimitPrice", () => {
  it("YES: uses the configured maximum winning cost", () => {
    assert.equal(computeLimitPrice("yes", 0.95), 0.95);
  });

  it("YES: quantizes down so the limit never exceeds configuration", () => {
    assert.equal(computeLimitPrice("yes", 0.954), 0.95);
  });

  it("NO: uses the symmetric YES-side complement of the winning-cost cap", () => {
    assert.equal(computeLimitPrice("no", 0.95), 0.05);
  });

  it("NO: non-cent configuration remains inside the configured cap", () => {
    const limitPrice = computeLimitPrice("no", 0.955);
    assert.equal(limitPrice, 0.05);
    assert.ok(1 - limitPrice <= 0.955);
  });

  it("YES remains marketable after a one-cent in-band quote move", () => {
    const observedWinningAsk = 0.92;
    const movedWinningAsk = observedWinningAsk + 0.01;
    const limitPrice = computeLimitPrice("yes", 0.95);
    assert.ok(limitPrice >= movedWinningAsk);
  });

  it("NO remains marketable after the symmetric one-cent in-band move", () => {
    const observedNoAsk = 0.92;
    const movedNoAsk = observedNoAsk + 0.01;
    const movedYesBid = 1 - movedNoAsk;
    const yesSideLimit = computeLimitPrice("no", 0.95);
    assert.ok(yesSideLimit <= movedYesBid);
  });

  it("allows Kalshi price improvement inside the hard execution cap", () => {
    const limitPrice = computeLimitPrice("yes", 0.95);
    const improvedFill = 0.92;
    assert.ok(improvedFill < limitPrice);
    assert.equal(winningCostFromFill("yes", improvedFill), improvedFill);
    assert.equal(isFillWithinBand("yes", improvedFill, 0.91, 0.95), true);
  });

  it("clamps to [0.01, 0.99]", () => {
    assert.equal(computeLimitPrice("yes", 0.001), 0.01);
    assert.equal(computeLimitPrice("yes", 0.999), 0.99);
  });
});

// ---------------------------------------------------------------------------
// winningCostFromFill — extracts winning-contract cost from YES-side fill
// ---------------------------------------------------------------------------

describe("winningCostFromFill", () => {
  it("YES: winning cost = avgFillPrice", () => {
    assert.equal(winningCostFromFill("yes", 0.95), 0.95);
  });

  it("NO: winning cost = 1 - avgFillPrice", () => {
    // avgFillPrice (YES-side) = 0.07 → NO cost = 1 - 0.07 = 0.93
    const wc = winningCostFromFill("no", 0.07);
    assert.ok(Math.abs(wc - 0.93) < 0.0001, `Expected ~0.93 got ${wc}`);
  });

  it("NO canonical: avgFillPrice=0.07 → winningCost=0.93", () => {
    const wc = winningCostFromFill("no", 0.07);
    assert.ok(Math.abs(wc - 0.93) < 0.0001, `Expected 0.93 got ${wc}`);
  });
});

// ---------------------------------------------------------------------------
// computeContractCount — CANONICAL: returns 0 when cannot afford one contract
// ---------------------------------------------------------------------------

describe("computeContractCount", () => {
  it("returns floor(budget / winningAsk)", () => {
    assert.equal(computeContractCount(2.00, 0.95), 2); // floor(2.00/0.95) = floor(2.105) = 2
  });

  it("returns 1 when budget >= winningAsk", () => {
    assert.equal(computeContractCount(0.95, 0.95), 1);
  });

  it("returns 0 when budget cannot afford one contract — NOT 1", () => {
    // Bug: previous impl returned 1 here
    assert.equal(computeContractCount(0.90, 0.95), 0);
    assert.equal(computeContractCount(0.50, 0.93), 0);
  });

  it("returns 0 for invalid inputs", () => {
    assert.equal(computeContractCount(0, 0.95), 0);
    assert.equal(computeContractCount(-1, 0.95), 0);
    assert.equal(computeContractCount(2, 0), 0);
    assert.equal(computeContractCount(2, 1), 0); // >= 1 is invalid
  });

  it("larger budget allows more contracts", () => {
    assert.equal(computeContractCount(10, 0.93), 10); // floor(10/0.93) = 10
  });
});

// ---------------------------------------------------------------------------
// computeScalpPnl — canonical contract economics (live and paper identical)
// ---------------------------------------------------------------------------

describe("computeScalpPnl", () => {
  // ── YES side ────────────────────────────────────────────────────────────
  it("YES win: +(1 - avgFillPrice) * filledCount", () => {
    // avgFillPrice=0.95 (YES-side), settled YES → win
    const pnl = computeScalpPnl("live", "yes", 2, 0.95, "yes");
    // (1 - 0.95) * 2 = 0.05 * 2 = 0.10
    assert.ok(Math.abs(pnl - 0.10) < 0.0001, `Expected 0.10 got ${pnl}`);
  });

  it("YES loss: -avgFillPrice * filledCount", () => {
    const pnl = computeScalpPnl("live", "yes", 2, 0.95, "no");
    // -0.95 * 2 = -1.90
    assert.ok(Math.abs(pnl - (-1.90)) < 0.0001, `Expected -1.90 got ${pnl}`);
  });

  // ── NO side (canonical) ─────────────────────────────────────────────────
  // noAsk=0.93, limitPrice(YES-side)=0.07, avgFillPrice(YES-side)=0.07
  // winningCost = 1 - 0.07 = 0.93
  // WIN: payout = avgFillPrice * count = 0.07 per contract
  // LOSS: cost = (1 - avgFillPrice) * count = 0.93 per contract

  it("NO win: +avgFillPrice * filledCount — canonical example", () => {
    // noAsk=0.93, avgFillPrice(YES-side)=0.07, settled NO → win
    const pnl = computeScalpPnl("live", "no", 1, 0.07, "no");
    // +0.07 * 1 = +0.07
    assert.ok(Math.abs(pnl - 0.07) < 0.0001, `Expected +0.07 got ${pnl}`);
  });

  it("NO loss: -(1 - avgFillPrice) * filledCount — canonical example", () => {
    // noAsk=0.93, avgFillPrice(YES-side)=0.07, settled YES → loss
    const pnl = computeScalpPnl("live", "no", 1, 0.07, "yes");
    // -(1 - 0.07) * 1 = -0.93
    assert.ok(Math.abs(pnl - (-0.93)) < 0.0001, `Expected -0.93 got ${pnl}`);
  });

  it("paper mode uses identical economics to live — NO win", () => {
    const paperPnl = computeScalpPnl("paper", "no", 1, 0.07, "no");
    const livePnl = computeScalpPnl("live", "no", 1, 0.07, "no");
    assert.equal(paperPnl, livePnl, "paper and live P&L must be identical");
  });

  it("paper mode uses identical economics to live — YES win", () => {
    const paperPnl = computeScalpPnl("paper", "yes", 2, 0.95, "yes");
    const livePnl = computeScalpPnl("live", "yes", 2, 0.95, "yes");
    assert.equal(paperPnl, livePnl);
  });

  it("paper mode uses identical economics to live — YES loss", () => {
    const paperPnl = computeScalpPnl("paper", "yes", 2, 0.95, "no");
    const livePnl = computeScalpPnl("live", "yes", 2, 0.95, "no");
    assert.equal(paperPnl, livePnl);
  });
});

// ---------------------------------------------------------------------------
// isFillWithinBand
// ---------------------------------------------------------------------------

describe("isFillWithinBand", () => {
  it("YES: checks avgFillPrice directly", () => {
    assert.ok(isFillWithinBand("yes", 0.95, 0.91, 0.98));
    assert.ok(!isFillWithinBand("yes", 0.50, 0.91, 0.98));
  });

  it("NO: checks 1 - avgFillPrice against band", () => {
    // avgFillPrice=0.07 (YES-side) → NO cost = 0.93 → in [0.91, 0.98]
    assert.ok(isFillWithinBand("no", 0.07, 0.91, 0.98));
    // avgFillPrice=0.50 (YES-side) → NO cost = 0.50 → not in [0.91, 0.98]
    assert.ok(!isFillWithinBand("no", 0.50, 0.91, 0.98));
  });
});

describe("classifyScalpFillAgainstBand", () => {
  const bandMin = 0.91;
  const bandMax = 0.95;

  it("classifies a YES fill below the minimum as favorable price improvement", () => {
    assert.deepEqual(
      classifyScalpFillAgainstBand("yes", 0.89, bandMin, bandMax),
      {
        classification: "favorable_price_improvement",
        winningContractCost: 0.89,
      },
    );
  });

  it("classifies a NO fill below the minimum as favorable price improvement", () => {
    const result = classifyScalpFillAgainstBand("no", 0.11, bandMin, bandMax);
    assert.equal(result.classification, "favorable_price_improvement");
    assert.ok(Math.abs(result.winningContractCost - 0.89) < 0.0001);
  });

  it("classifies YES and NO fills above the ceiling as adverse limit breaches", () => {
    assert.equal(
      classifyScalpFillAgainstBand("yes", 0.96, bandMin, bandMax).classification,
      "adverse_limit_breach",
    );
    assert.equal(
      classifyScalpFillAgainstBand("no", 0.04, bandMin, bandMax).classification,
      "adverse_limit_breach",
    );
  });

  it("keeps both exact boundaries within band", () => {
    assert.equal(
      classifyScalpFillAgainstBand("yes", bandMin, bandMin, bandMax).classification,
      "within_band",
    );
    assert.equal(
      classifyScalpFillAgainstBand("yes", bandMax, bandMin, bandMax).classification,
      "within_band",
    );
  });
});

// ---------------------------------------------------------------------------
// validateOrderbookQuote
// ---------------------------------------------------------------------------

describe("validateOrderbookQuote", () => {
  const closeTime = "2024-01-01T12:00:00Z";
  const ticker = "BTC-2024-01-01T12:00:00Z";

  it("returns ValidatedQuote for valid two-sided book", () => {
    const q = validateOrderbookQuote({ yesAsk: 0.05, yesBid: 0.04 }, ticker, closeTime);
    assert.ok(q);
    assert.equal(q.yesAsk, 0.05);
    assert.equal(q.yesBid, 0.04);
    // noAsk = 1 - yesBid = 0.96
    assert.ok(Math.abs(q.noAsk - 0.96) < 0.0001);
    assert.equal(q.ticker, ticker);
    assert.equal(q.closeTime, closeTime);
  });

  it("noAsk = 1 - yesBid is computed correctly", () => {
    // yesBid=0.07 → noAsk = 0.93
    const q = validateOrderbookQuote({ yesAsk: 0.08, yesBid: 0.07 }, ticker, closeTime);
    assert.ok(q);
    assert.ok(Math.abs(q.noAsk - 0.93) < 0.0001, `noAsk should be 0.93, got ${q.noAsk}`);
  });

  it("returns null for null yesAsk", () => {
    assert.equal(validateOrderbookQuote({ yesAsk: null, yesBid: 0.04 }, ticker, closeTime), null);
  });

  it("returns null for null yesBid", () => {
    assert.equal(validateOrderbookQuote({ yesAsk: 0.05, yesBid: null }, ticker, closeTime), null);
  });

  it("returns null for inverted/crossed book (bid >= ask)", () => {
    assert.equal(validateOrderbookQuote({ yesAsk: 0.04, yesBid: 0.05 }, ticker, closeTime), null);
    assert.equal(validateOrderbookQuote({ yesAsk: 0.05, yesBid: 0.05 }, ticker, closeTime), null);
  });

  it("returns null for zero/invalid prices", () => {
    assert.equal(validateOrderbookQuote({ yesAsk: 0, yesBid: 0 }, ticker, closeTime), null);
    assert.equal(validateOrderbookQuote({ yesAsk: 1.0, yesBid: 0.95 }, ticker, closeTime), null);
  });

  it("canonical NO case: yesAsk=0.08, yesBid=0.07 → noAsk=0.93 (two-sided valid book)", () => {
    // yesBid=0.07, yesAsk=0.08 — valid book (bid < ask).
    // noAsk = 1 - yesBid = 0.93 — cost to buy NO.
    // yesAsk=0.08 is out-of-band [0.91, 0.98]; noAsk=0.93 is in band.
    const q = validateOrderbookQuote({ yesAsk: 0.08, yesBid: 0.07 }, ticker, closeTime);
    assert.ok(q, "quote should be valid: bid(0.07) < ask(0.08)");
    assert.equal(q.yesAsk, 0.08);
    assert.equal(q.yesBid, 0.07);
    assert.ok(Math.abs(q.noAsk - 0.93) < 0.0001, `noAsk expected 0.93 got ${q.noAsk}`);
    // And the NO band check would find noAsk=0.93 in [0.91, 0.98]
    const match = selectScalpSide(q.yesAsk, q.noAsk, 0.91, 0.98);
    assert.ok(match);
    assert.equal(match.side, "no");
    assert.ok(Math.abs(match.winningAsk - 0.93) < 0.0001);
    // With a 0.98 band cap, the marketable NO limit is YES-side 0.02.
    const lp = computeLimitPrice("no", 0.98);
    assert.equal(lp, 0.02);
    // P&L on NO win: payout = avgFillPrice (YES-side = 0.07)
    const pnl = computeScalpPnl("live", "no", 1, 0.07, "no");
    assert.ok(Math.abs(pnl - 0.07) < 0.0001, `NO win pnl expected +0.07 got ${pnl}`);
  });
});

// ---------------------------------------------------------------------------
// isInFinalWindow
// ---------------------------------------------------------------------------

describe("isInFinalWindow", () => {
  it("returns true when within window seconds of close", () => {
    const now = Date.now();
    const closeTime = new Date(now + 90_000).toISOString(); // 90 seconds from now
    assert.ok(isInFinalWindow(closeTime, now, 120));
  });

  it("returns false when close has already passed", () => {
    const now = Date.now();
    const closeTime = new Date(now - 1_000).toISOString();
    assert.ok(!isInFinalWindow(closeTime, now, 120));
  });

  it("returns false when more than finalWindowSeconds remain", () => {
    const now = Date.now();
    const closeTime = new Date(now + 300_000).toISOString(); // 5 minutes — too far
    assert.ok(!isInFinalWindow(closeTime, now, 120));
  });

  it("returns false for invalid close time", () => {
    assert.ok(!isInFinalWindow("not-a-date", Date.now(), 120));
  });

  it("validates against currentWindowKey when provided", () => {
    // Window key "2024-01-01T12:00" → window is 12:00–12:15 UTC
    const closeTime = "2024-01-01T12:14:00Z"; // inside window
    const wkGood = "2024-01-01T12:00";
    const nowMs = new Date("2024-01-01T12:13:30Z").getTime();
    assert.ok(isInFinalWindow(closeTime, nowMs, 120, wkGood));

    // Adjacent window key — close time does NOT fall in this window
    const wkBad = "2024-01-01T12:15";
    assert.ok(!isInFinalWindow(closeTime, nowMs, 120, wkBad));
  });

  // ── 45-second inclusive/exclusive boundary tests ──────────────────────────

  it("returns true when exactly 45 seconds remain (inclusive)", () => {
    const nowMs = Date.now();
    const closeTime = new Date(nowMs + 45_000).toISOString();
    // With finalWindowSeconds=45: remainingS = 45 — should be in window (0 < 45 <= 45)
    assert.ok(isInFinalWindow(closeTime, nowMs, 45), "45 s remaining is inclusive");
  });

  it("returns false when exactly 45 seconds + 1 ms remain (exclusive upper boundary)", () => {
    const nowMs = Date.now();
    // 45_001 ms → remainingS = 45.001 > finalWindowSeconds=45 → outside
    const closeTime = new Date(nowMs + 45_001).toISOString();
    assert.ok(!isInFinalWindow(closeTime, nowMs, 45), "45.001 s remaining is outside the 45 s window");
  });

  it("returns false when 0 seconds remain (exclusive lower boundary — closed)", () => {
    const nowMs = Date.now();
    const closeTime = new Date(nowMs).toISOString(); // exactly now
    assert.ok(!isInFinalWindow(closeTime, nowMs, 45), "0 s remaining is excluded (closed)");
  });

  it("returns true when 1 ms remains (still open, just barely in window)", () => {
    const nowMs = Date.now();
    const closeTime = new Date(nowMs + 1).toISOString();
    assert.ok(isInFinalWindow(closeTime, nowMs, 45), "1 ms remaining is inside window");
  });

  // ── Per-market windowSeconds override tests ───────────────────────────────

  it("respects a per-market windowSeconds override via resolveEffectiveParams", () => {
    const config = {
      ...DEFAULT_SCALP_CONFIG,
      finalWindowSeconds: 120,
      perMarketOverrides: [
        { symbol: "BTCA", windowSeconds: 45 },
      ],
    };
    const paramsOverride = resolveEffectiveParams(config, "BTCA", "BTCA-TICKER");
    const paramsDefault = resolveEffectiveParams(config, "ETHB", "ETHB-TICKER");

    // Override market: effective window is 45 s
    assert.equal(paramsOverride.finalWindowSeconds, 45);
    // Non-override market: falls back to global default 120 s
    assert.equal(paramsDefault.finalWindowSeconds, 120);

    const nowMs = Date.now();
    // 60 s remaining → inside 120 s default window but outside 45 s override
    const closeTime60 = new Date(nowMs + 60_000).toISOString();
    assert.ok(!isInFinalWindow(closeTime60, nowMs, paramsOverride.finalWindowSeconds),
      "60 s remaining is outside 45 s override window");
    assert.ok(isInFinalWindow(closeTime60, nowMs, paramsDefault.finalWindowSeconds),
      "60 s remaining is inside 120 s default window");

    // 44 s remaining → inside 45 s override window
    const closeTime44 = new Date(nowMs + 44_000).toISOString();
    assert.ok(isInFinalWindow(closeTime44, nowMs, paramsOverride.finalWindowSeconds),
      "44 s remaining is inside 45 s override window");
  });
});

// ---------------------------------------------------------------------------
// resolveTimingPhase
// ---------------------------------------------------------------------------

describe("resolveTimingPhase", () => {
  const WIN_S = 120; // default final window seconds
  const LEAD_S = SCALP_PREFLIGHT_LEAD_SECONDS;

  it("returns 'waiting_eligibility' when close time is null", () => {
    assert.equal(resolveTimingPhase(null, Date.now(), WIN_S, LEAD_S), "waiting_eligibility");
    assert.equal(resolveTimingPhase(undefined, Date.now(), WIN_S, LEAD_S), "waiting_eligibility");
    assert.equal(resolveTimingPhase("", Date.now(), WIN_S, LEAD_S), "waiting_eligibility");
  });

  it("returns 'waiting_eligibility' for invalid date", () => {
    assert.equal(resolveTimingPhase("not-a-date", Date.now(), WIN_S, LEAD_S), "waiting_eligibility");
  });

  it("returns 'closed_expired' when close time has passed", () => {
    const nowMs = Date.now();
    const closeTime = new Date(nowMs - 1_000).toISOString();
    assert.equal(resolveTimingPhase(closeTime, nowMs, WIN_S, LEAD_S), "closed_expired");
  });

  it("returns 'closed_expired' when remaining is exactly 0", () => {
    const nowMs = Date.now();
    const closeTime = new Date(nowMs).toISOString();
    assert.equal(resolveTimingPhase(closeTime, nowMs, WIN_S, LEAD_S), "closed_expired");
  });

  it("returns 'eligible' when within finalWindowSeconds", () => {
    const nowMs = Date.now();
    const closeTime = new Date(nowMs + 90_000).toISOString(); // 90 s < 120 s
    assert.equal(resolveTimingPhase(closeTime, nowMs, WIN_S, LEAD_S), "eligible");
  });

  it("returns 'eligible' at exactly finalWindowSeconds remaining", () => {
    const nowMs = Date.now();
    const closeTime = new Date(nowMs + 120_000).toISOString(); // exactly 120 s
    assert.equal(resolveTimingPhase(closeTime, nowMs, WIN_S, LEAD_S), "eligible");
  });

  it("returns 'preflight_warmup' when within preflight lead but outside final window", () => {
    const nowMs = Date.now();
    // 150 s remaining: > 120 (window) but <= 120 + LEAD_S
    const closeTime = new Date(nowMs + (WIN_S + LEAD_S / 2) * 1000).toISOString();
    const phase = resolveTimingPhase(closeTime, nowMs, WIN_S, LEAD_S);
    assert.equal(phase, "preflight_warmup");
  });

  it("returns 'waiting_eligibility' when far from close (beyond lead window)", () => {
    const nowMs = Date.now();
    // Way beyond finalWindowSeconds + preflightLeadSeconds
    const closeTime = new Date(nowMs + (WIN_S + LEAD_S + 3600) * 1000).toISOString();
    assert.equal(resolveTimingPhase(closeTime, nowMs, WIN_S, LEAD_S), "waiting_eligibility");
  });
});

// ---------------------------------------------------------------------------
// secondsUntilEligible
// ---------------------------------------------------------------------------

describe("secondsUntilEligible", () => {
  const WIN_S = 120;

  it("returns null when close time is null/empty", () => {
    assert.equal(secondsUntilEligible(null, Date.now(), WIN_S), null);
    assert.equal(secondsUntilEligible(undefined, Date.now(), WIN_S), null);
    assert.equal(secondsUntilEligible("", Date.now(), WIN_S), null);
  });

  it("returns null when close time has expired", () => {
    const nowMs = Date.now();
    const closeTime = new Date(nowMs - 5_000).toISOString();
    assert.equal(secondsUntilEligible(closeTime, nowMs, WIN_S), null);
  });

  it("returns 0 when already inside the final window", () => {
    const nowMs = Date.now();
    const closeTime = new Date(nowMs + 90_000).toISOString(); // 90 s in
    assert.equal(secondsUntilEligible(closeTime, nowMs, WIN_S), 0);
  });

  it("returns the seconds until window opens when outside final window", () => {
    const nowMs = Date.now();
    // 180 s remaining, window=120 s → eligible in 60 s
    const closeTime = new Date(nowMs + 180_000).toISOString();
    const result = secondsUntilEligible(closeTime, nowMs, WIN_S);
    assert.ok(result != null);
    // Allow ±1 s tolerance for timing jitter
    assert.ok(Math.abs(result - 60) <= 1, `expected ~60, got ${result}`);
  });
});

// ---------------------------------------------------------------------------
// Bounded reservation retries
// ---------------------------------------------------------------------------

describe("evaluateScalpReservationRetry", () => {
  it("re-arms transient quote movement after the short cooldown", () => {
    const cooling = evaluateScalpReservationRetry({
      status: "skipped",
      reason: "final_quote_outside_band",
      elapsedMs: 100,
      submittedOrders: 0,
    });
    assert.equal(cooling.retryableNow, false);
    assert.equal(cooling.retryAfterMs, SCALP_AUTH_RETRY_COOLDOWN_MS - 100);
    assert.equal(cooling.terminal, false);

    const ready = evaluateScalpReservationRetry({
      status: "skipped",
      reason: "side_flipped_final_quote",
      elapsedMs: SCALP_AUTH_RETRY_COOLDOWN_MS,
      submittedOrders: 0,
    });
    assert.equal(ready.retryableNow, true);
    assert.equal(ready.retryAfterMs, 0);
  });

  it("uses slower retries for guard and balance readiness", () => {
    const freefall = evaluateScalpReservationRetry({
      status: "skipped",
      reason: "freefall_unavailable_fetch_failed",
      elapsedMs: 0,
      submittedOrders: 0,
    });
    const targetProximity = evaluateScalpReservationRetry({
      status: "skipped",
      reason: "target_proximity_too_close",
      elapsedMs: 0,
      submittedOrders: 0,
    });
    const balance = evaluateScalpReservationRetry({
      status: "skipped",
      reason: "balance_check_failed_final",
      elapsedMs: 0,
      submittedOrders: 0,
    });
    assert.equal(freefall.retryAfterMs, SCALP_GUARD_RETRY_COOLDOWN_MS);
    assert.equal(targetProximity.retryAfterMs, SCALP_GUARD_RETRY_COOLDOWN_MS);
    assert.equal(targetProximity.terminal, false);
    assert.equal(balance.retryAfterMs, SCALP_BALANCE_RETRY_COOLDOWN_MS);
  });

  it("allows confirmed zero fills only below the submission limit", () => {
    const second = evaluateScalpReservationRetry({
      status: "zero_fill",
      reason: "zero_fill",
      elapsedMs: SCALP_AUTH_RETRY_COOLDOWN_MS,
      submittedOrders: SCALP_MAX_SUBMISSIONS_PER_WINDOW - 1,
    });
    assert.equal(second.retryableNow, true);

    const exhausted = evaluateScalpReservationRetry({
      status: "zero_fill",
      reason: "zero_fill",
      elapsedMs: 60_000,
      submittedOrders: SCALP_MAX_SUBMISSIONS_PER_WINDOW,
    });
    assert.equal(exhausted.retryableNow, false);
    assert.equal(exhausted.retryAfterMs, null);
    assert.equal(exhausted.terminal, true);
    assert.equal(exhausted.reason, "retry_limit_reached");
  });

  it("never retries filled, unknown, submitting, cap, identity, or arbitrary errors", () => {
    for (const outcome of [
      { status: "filled", reason: null },
      { status: "unknown", reason: "manual_reconciliation_required" },
      { status: "submitting", reason: null },
      { status: "skipped", reason: "daily_cap_exceeded" },
      { status: "skipped", reason: "identity_changed" },
      { status: "error", reason: "network_error" },
    ]) {
      const decision = evaluateScalpReservationRetry({
        ...outcome,
        elapsedMs: 60_000,
        submittedOrders: 0,
      });
      assert.equal(decision.terminal, true, `${outcome.status}:${outcome.reason}`);
      assert.equal(decision.retryAfterMs, null, `${outcome.status}:${outcome.reason}`);
    }
  });
});

// ---------------------------------------------------------------------------
// checkFreefallGuard
// ---------------------------------------------------------------------------

describe("checkFreefallGuard", () => {
  const nowMs = 1_700_000_000_000;
  const lookbackMs = 30_000;

  // Build samples covering ~full lookback with a fresh newest (age ~1s).
  // oldest at now-28s, newest at now-1s → span 27s (> required 22.5s), fresh.
  function makeSamples(prices: number[]): FreefallSample[] {
    const n = prices.length;
    const startMs = nowMs - 28_000;
    const endMs = nowMs - 1_000;
    const stepMs = n > 1 ? (endMs - startMs) / (n - 1) : 0;
    return prices.map((price, i) => ({ price, at: Math.round(startMs + i * stepMs) }));
  }

  it("blocks YES when price falling sharply (evaluable)", () => {
    const samples = makeSamples([100, 99, 97, 95, 93]);
    const result = checkFreefallGuard(samples, "yes", nowMs, lookbackMs, 5);
    assert.equal(result.evaluable, true);
    assert.ok(result.blocked);
    assert.ok(result.reason?.includes("freefall_adverse_falling"));
  });

  it("does NOT block YES on rising price (evaluable, clear reason=null)", () => {
    const samples = makeSamples([90, 92, 95, 97]);
    const result = checkFreefallGuard(samples, "yes", nowMs, lookbackMs, 5);
    assert.equal(result.evaluable, true);
    assert.ok(!result.blocked);
    assert.equal(result.reason, null);
  });

  it("blocks NO when price rising sharply (evaluable)", () => {
    const samples = makeSamples([90, 92, 95, 97, 100]);
    const result = checkFreefallGuard(samples, "no", nowMs, lookbackMs, 5);
    assert.equal(result.evaluable, true);
    assert.ok(result.blocked);
    assert.ok(result.reason?.includes("freefall_adverse_rising"));
  });

  it("does NOT block NO on falling price (evaluable, clear reason=null)", () => {
    const samples = makeSamples([100, 98, 96, 94]);
    const result = checkFreefallGuard(samples, "no", nowMs, lookbackMs, 5);
    assert.equal(result.evaluable, true);
    assert.ok(!result.blocked);
    assert.equal(result.reason, null);
  });

  it("blocks YES after a sharp peak-to-latest reversal even when the endpoint move is favorable", () => {
    const samples = makeSamples([100, 103, 106, 104]);
    const result = checkFreefallGuard(samples, "yes", nowMs, lookbackMs, 1.5);
    assert.equal(result.evaluable, true);
    assert.equal(result.blocked, true);
    assert.equal(result.reason, "freefall_adverse_reversal_falling");
    assert.equal(result.endpointAdverseMovePct, 0);
    assert.ok(result.reversalAdverseMovePct > 1.8);
  });

  it("blocks NO after a sharp trough-to-latest reversal even when the endpoint move is favorable", () => {
    const samples = makeSamples([100, 97, 94, 96]);
    const result = checkFreefallGuard(samples, "no", nowMs, lookbackMs, 1.5);
    assert.equal(result.evaluable, true);
    assert.equal(result.blocked, true);
    assert.equal(result.reason, "freefall_adverse_reversal_rising");
    assert.equal(result.endpointAdverseMovePct, 0);
    assert.ok(result.reversalAdverseMovePct > 2);
  });

  // ── Fail-closed unavailability ─────────────────────────────────────────────

  it("startup / NO samples → unavailable (not evaluable, not blocked, not clear)", () => {
    const result = checkFreefallGuard([], "yes", nowMs, lookbackMs, 5);
    assert.equal(result.evaluable, false);
    assert.equal(result.blocked, false);
    assert.equal(result.reason, "freefall_unavailable_no_samples");
  });

  it("ONE sample → unavailable", () => {
    const result = checkFreefallGuard([{ price: 100, at: nowMs - 1_000 }], "yes", nowMs, lookbackMs, 5);
    assert.equal(result.evaluable, false);
    assert.equal(result.reason, "freefall_unavailable_no_samples");
    assert.equal(result.samplesUsed, 1);
  });

  it("stale latest sample → unavailable (blind to now)", () => {
    // Two samples but newest is 10s old (> 5s max age) though span covers lookback.
    const samples: FreefallSample[] = [
      { price: 100, at: nowMs - 30_000 },
      { price: 90, at: nowMs - 10_000 },
    ];
    const result = checkFreefallGuard(samples, "yes", nowMs, lookbackMs, 5);
    assert.equal(result.evaluable, false);
    assert.equal(result.reason, "freefall_unavailable_stale");
  });

  it("insufficient lookback coverage → unavailable (new symbol, only ~2s of data)", () => {
    // Fresh, ≥2 samples, but span only 2s vs 30s lookback → cannot trade yet.
    const samples: FreefallSample[] = [
      { price: 100, at: nowMs - 2_000 },
      { price: 99.9, at: nowMs - 500 },
    ];
    const result = checkFreefallGuard(samples, "yes", nowMs, lookbackMs, 5);
    assert.equal(result.evaluable, false);
    assert.equal(result.reason, "freefall_unavailable_coverage");
  });

  it("invalid samples (NaN/Infinity/non-positive) are dropped → unavailable if <2 remain", () => {
    const samples: FreefallSample[] = [
      { price: NaN, at: nowMs - 28_000 },
      { price: Infinity, at: nowMs - 20_000 },
      { price: -5, at: nowMs - 10_000 },
      { price: 100, at: nowMs - 1_000 }, // only 1 valid
    ];
    const result = checkFreefallGuard(samples, "yes", nowMs, lookbackMs, 5);
    assert.equal(result.evaluable, false);
    assert.equal(result.reason, "freefall_unavailable_no_samples");
    assert.equal(result.samplesUsed, 1);
  });

  it("out-of-order samples are unavailable rather than producing a misleading clear", () => {
    const samples: FreefallSample[] = [
      { price: 100, at: nowMs - 28_000 },
      { price: 101, at: nowMs - 1_000 },
      { price: 99, at: nowMs - 2_000 },
    ];
    const result = checkFreefallGuard(samples, "yes", nowMs, lookbackMs, 0.5);
    assert.equal(result.evaluable, false);
    assert.equal(result.reason, "freefall_unavailable_out_of_order");
  });

  it("full coverage, fresh, clear move below threshold → evaluable & not blocked", () => {
    const samples = makeSamples([100, 100.1, 100.05, 100.2]); // tiny move
    const result = checkFreefallGuard(samples, "yes", nowMs, lookbackMs, 5);
    assert.equal(result.evaluable, true);
    assert.equal(result.blocked, false);
    assert.equal(result.reason, null);
  });
});

describe("checkTargetProximityGuard", () => {
  it("blocks either side's opportunity when live price is inside the configured target buffer", () => {
    const result = checkTargetProximityGuard(1.8861, 1.8862, 0.05);
    assert.equal(result.evaluable, true);
    assert.equal(result.blocked, true);
    assert.equal(result.reason, "target_proximity_too_close");
    assert.ok((result.distancePct ?? Infinity) < 0.01);
  });

  it("blocks exactly at the threshold boundary", () => {
    const result = checkTargetProximityGuard(100.05, 100, 0.05);
    assert.equal(result.evaluable, true);
    assert.equal(result.blocked, true);
  });

  it("allows a price safely beyond the configured target buffer", () => {
    const result = checkTargetProximityGuard(100.2, 100, 0.05);
    assert.equal(result.evaluable, true);
    assert.equal(result.blocked, false);
    assert.equal(result.reason, null);
  });

  it("fails closed when live price, target, or threshold is invalid", () => {
    for (const result of [
      checkTargetProximityGuard(null, 100, 0.05),
      checkTargetProximityGuard(100, null, 0.05),
      checkTargetProximityGuard(100, 100, 0),
      checkTargetProximityGuard(NaN, 100, 0.05),
    ]) {
      assert.equal(result.evaluable, false);
      assert.equal(result.blocked, false);
      assert.ok(result.reason?.startsWith("target_proximity_unavailable"));
    }
  });
});

describe("resolveScalpMarketState", () => {
  const base = {
    paused: false,
    hasQuote: true,
    hasMatch: true,
    inWindow: true,
    guardBlocked: false,
  };

  it("marks an in-window in-band market guarded when any safety guard blocks", () => {
    assert.equal(resolveScalpMarketState({ ...base, guardBlocked: true }), "guarded");
  });

  it("only marks a safe in-window in-band market active", () => {
    assert.equal(resolveScalpMarketState(base), "active");
  });
});

// ---------------------------------------------------------------------------
// checkDailyCap / checkOpenCap
// ---------------------------------------------------------------------------

describe("checkDailyCap", () => {
  it("allows when no cap set", () => {
    const r = checkDailyCap(null, 100, 5);
    assert.ok(r.allowed);
  });
  it("allows when committed + budget <= cap", () => {
    const r = checkDailyCap(20, 15, 5);
    assert.ok(r.allowed);
  });
  it("blocks when committed + budget > cap", () => {
    const r = checkDailyCap(20, 16, 5);
    assert.ok(!r.allowed);
    assert.ok(r.reason?.includes("daily_cap_exceeded"));
  });
});

describe("checkOpenCap", () => {
  it("allows when the finite cap has enough headroom", () => {
    const r = checkOpenCap(50, 40, 5);
    assert.ok(r.allowed);
  });
  it("allows when committed + budget <= cap", () => {
    const r = checkOpenCap(10, 5, 4);
    assert.ok(r.allowed);
  });
  it("blocks when committed + budget > cap", () => {
    const r = checkOpenCap(10, 7, 4);
    assert.ok(!r.allowed);
    assert.ok(r.reason?.includes("open_cap_exceeded"));
  });
  it("honors an operator cap above the old $50 default without clipping it", () => {
    assert.equal(checkOpenCap(500, 498, 2).allowed, true);
    const blocked = checkOpenCap(500, 498.01, 2);
    assert.equal(blocked.allowed, false);
    assert.ok(blocked.reason?.includes("cap=500"));
  });
  it("fails closed to the default when a legacy runtime caller passes null", () => {
    const r = checkOpenCap(
      null as unknown as number,
      DEFAULT_SCALP_OPEN_CAP_DOLLARS - 1,
      2,
    );
    assert.equal(r.allowed, false);
    assert.ok(r.reason?.includes(`cap=${DEFAULT_SCALP_OPEN_CAP_DOLLARS}`));
  });
});

describe("normalizeScalpOpenCapDollars", () => {
  it("preserves every positive finite operator value and defaults invalid legacy shapes", () => {
    assert.equal(normalizeScalpOpenCapDollars(40), 40);
    assert.equal(normalizeScalpOpenCapDollars(75), 75);
    assert.equal(normalizeScalpOpenCapDollars(500), 500);
    assert.equal(normalizeScalpOpenCapDollars(10_000), 10_000);
    for (const legacyValue of [null, undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, "50"]) {
      assert.equal(
        normalizeScalpOpenCapDollars(legacyValue),
        DEFAULT_SCALP_OPEN_CAP_DOLLARS,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// evaluateCapDecision — pure mirror of the atomic SQL claim-and-cap decision
// ---------------------------------------------------------------------------

describe("evaluateCapDecision (atomic cap boundary math)", () => {
  it("normalizes a legacy null open cap to the finite default", () => {
    const d = evaluateCapDecision(
      5,
      0,
      DEFAULT_SCALP_OPEN_CAP_DOLLARS - 4,
      null,
      null as unknown as number,
    );
    assert.equal(d.allowed, false);
    assert.ok(d.reason?.includes("open_cap_exceeded"));
    assert.ok(d.reason?.includes(`cap=${DEFAULT_SCALP_OPEN_CAP_DOLLARS}`));
  });

  it("allows exactly at the daily cap boundary (total == cap)", () => {
    // 18 committed + 2 budget = 20 == cap → allowed (strict >)
    const d = evaluateCapDecision(2, 18, 0, 20, DEFAULT_SCALP_OPEN_CAP_DOLLARS);
    assert.ok(d.allowed, "reaching the cap exactly must be allowed");
  });

  it("blocks one cent over the daily cap boundary", () => {
    // 18.01 + 2 = 20.01 > 20 → blocked
    const d = evaluateCapDecision(2, 18.01, 0, 20, DEFAULT_SCALP_OPEN_CAP_DOLLARS);
    assert.ok(!d.allowed);
    assert.ok(d.reason?.includes("daily_cap_exceeded"));
  });

  it("allows exactly at the open cap boundary (total == cap)", () => {
    const d = evaluateCapDecision(4, 6, 6, null, 10);
    assert.ok(d.allowed);
  });

  it("blocks over the open cap boundary", () => {
    const d = evaluateCapDecision(4, 0, 7, null, 10);
    assert.ok(!d.allowed);
    assert.ok(d.reason?.includes("open_cap_exceeded"));
  });

  it("daily cap takes precedence over open cap in the reason", () => {
    // Both exceeded; daily is checked first.
    const d = evaluateCapDecision(5, 100, 100, 10, 10);
    assert.ok(!d.allowed);
    assert.ok(d.reason?.includes("daily_cap_exceeded"));
  });

  it("committed totals already include reserved (no self double-count expected)", () => {
    // Simulate: 2 prior reservations of $2 each already reserved = $4 committed.
    // A 3rd $2 attempt with a $6 daily cap: 4 + 2 = 6 == cap → allowed.
    const d = evaluateCapDecision(2, 4, 4, 6, 6);
    assert.ok(d.allowed);
    // A 4th would be 6 + 2 = 8 > 6 → blocked.
    const d2 = evaluateCapDecision(2, 6, 6, 6, 6);
    assert.ok(!d2.allowed);
  });

  it("open cap with zero committed allows first attempt up to cap", () => {
    assert.ok(evaluateCapDecision(10, 0, 0, null, 10).allowed);
    assert.ok(!evaluateCapDecision(10.01, 0, 0, null, 10).allowed);
  });
});

// ---------------------------------------------------------------------------
// classifyPlaceOrderResult — exact fail-closed result classification
// ---------------------------------------------------------------------------

describe("classifyPlaceOrderResult", () => {
  // (1) filledCount === 0 => zero_fill regardless of avg
  it("filledCount 0 with null avg => zero_fill", () => {
    assert.equal(classifyPlaceOrderResult({ filledCount: 0, avgFillPrice: null }), "zero_fill");
  });
  it("filledCount 0 with a finite avg => zero_fill (count dominates)", () => {
    assert.equal(classifyPlaceOrderResult({ filledCount: 0, avgFillPrice: 0.5 }), "zero_fill");
  });
  it("filledCount 0 with NaN avg => zero_fill", () => {
    assert.equal(classifyPlaceOrderResult({ filledCount: 0, avgFillPrice: NaN }), "zero_fill");
  });

  // (2) filledCount > 0 AND avg finite in (0,1) => confirmed_fill
  it("filledCount>0 with avg in (0,1) => confirmed_fill", () => {
    assert.equal(classifyPlaceOrderResult({ filledCount: 3, avgFillPrice: 0.92 }), "confirmed_fill");
  });
  it("filledCount>0 with tiny positive avg => confirmed_fill", () => {
    assert.equal(classifyPlaceOrderResult({ filledCount: 1, avgFillPrice: 0.0001 }), "confirmed_fill");
  });
  it("filledCount>0 with avg just under 1 => confirmed_fill", () => {
    assert.equal(classifyPlaceOrderResult({ filledCount: 1, avgFillPrice: 0.9999 }), "confirmed_fill");
  });

  // (3) filledCount > 0 AND avg null/nonfinite/out-of-(0,1) => unknown
  it("filledCount>0 with null avg => unknown (response cannot be verified)", () => {
    assert.equal(classifyPlaceOrderResult({ filledCount: 2, avgFillPrice: null }), "unknown");
  });
  it("filledCount>0 with NaN avg => unknown", () => {
    assert.equal(classifyPlaceOrderResult({ filledCount: 2, avgFillPrice: NaN }), "unknown");
  });
  it("filledCount>0 with Infinity avg => unknown", () => {
    assert.equal(classifyPlaceOrderResult({ filledCount: 2, avgFillPrice: Infinity }), "unknown");
  });
  it("filledCount>0 with avg === 0 (boundary) => unknown", () => {
    assert.equal(classifyPlaceOrderResult({ filledCount: 2, avgFillPrice: 0 }), "unknown");
  });
  it("filledCount>0 with avg === 1 (boundary) => unknown", () => {
    assert.equal(classifyPlaceOrderResult({ filledCount: 2, avgFillPrice: 1 }), "unknown");
  });
  it("filledCount>0 with avg > 1 => unknown", () => {
    assert.equal(classifyPlaceOrderResult({ filledCount: 2, avgFillPrice: 1.5 }), "unknown");
  });
  it("filledCount>0 with negative avg => unknown", () => {
    assert.equal(classifyPlaceOrderResult({ filledCount: 2, avgFillPrice: -0.1 }), "unknown");
  });

  // Defensive: garbage filledCount
  it("negative filledCount => unknown", () => {
    assert.equal(classifyPlaceOrderResult({ filledCount: -1, avgFillPrice: 0.5 }), "unknown");
  });
  it("NaN filledCount => unknown", () => {
    assert.equal(classifyPlaceOrderResult({ filledCount: NaN, avgFillPrice: 0.5 }), "unknown");
  });

  // Explicit distinction: null avg means zero_fill when count 0, unknown when count>0
  it("null avg: zero_fill vs unknown depends solely on filledCount", () => {
    assert.equal(classifyPlaceOrderResult({ filledCount: 0, avgFillPrice: null }), "zero_fill");
    assert.equal(classifyPlaceOrderResult({ filledCount: 1, avgFillPrice: null }), "unknown");
  });

  it("Kalshi FixedPointCount fractional fills are confirmed at hundredth precision", () => {
    assert.equal(classifyPlaceOrderResult({ filledCount: 1.5, avgFillPrice: 0.9 }), "confirmed_fill");
    assert.equal(classifyPlaceOrderResult({ filledCount: 0.5, avgFillPrice: 0.9 }), "confirmed_fill");
    assert.equal(classifyPlaceOrderResult({ filledCount: 2.0001, avgFillPrice: 0.9 }), "unknown");
  });
  it("null filledCount => unknown", () => {
    assert.equal(classifyPlaceOrderResult({ filledCount: null, avgFillPrice: 0.9 }), "unknown");
  });

  // Overfill: filledCount > requestedCount is impossible → unknown.
  it("filledCount > requestedCount => unknown (overfill)", () => {
    assert.equal(
      classifyPlaceOrderResult({ filledCount: 5, avgFillPrice: 0.9, requestedCount: 3 }),
      "unknown",
    );
  });
  it("filledCount === requestedCount with valid avg => confirmed_fill", () => {
    assert.equal(
      classifyPlaceOrderResult({ filledCount: 3, avgFillPrice: 0.9, requestedCount: 3 }),
      "confirmed_fill",
    );
  });
  it("bad requestedCount (0 / fractional) => unknown", () => {
    assert.equal(classifyPlaceOrderResult({ filledCount: 1, avgFillPrice: 0.9, requestedCount: 0 }), "unknown");
    assert.equal(classifyPlaceOrderResult({ filledCount: 1, avgFillPrice: 0.9, requestedCount: 2.5 }), "unknown");
  });
  it("zero fill still zero_fill even with requestedCount supplied", () => {
    assert.equal(
      classifyPlaceOrderResult({ filledCount: 0, avgFillPrice: null, requestedCount: 3 }),
      "zero_fill",
    );
  });
});

// ---------------------------------------------------------------------------
// parseScalpOrderResponse — strict raw exchange-response parser (fail-closed)
// ---------------------------------------------------------------------------

describe("parseScalpOrderResponse", () => {
  const REQ = 3; // requested count for most cases

  // ── bad requestedCount ─────────────────────────────────────────────────
  it("bad requestedCount => unknown/bad_requested_count", () => {
    const r = parseScalpOrderResponse({ order_id: "o", fill_count: 1, average_fill_price: 0.9 }, 0);
    assert.equal(r.outcome, "unknown");
    assert.equal(r.reason, "bad_requested_count");
  });

  // ── top-level shape ────────────────────────────────────────────────────
  it("non-object body => unknown/non_object_response", () => {
    for (const bad of [null, undefined, 42, "x", [] as unknown]) {
      const r = parseScalpOrderResponse(bad, REQ);
      assert.equal(r.outcome, "unknown");
      assert.equal(r.reason, "non_object_response");
    }
  });

  // ── order_id ───────────────────────────────────────────────────────────
  it("missing order_id => unknown/missing_order_id", () => {
    const r = parseScalpOrderResponse({ fill_count: 0 }, REQ);
    assert.equal(r.outcome, "unknown");
    assert.equal(r.reason, "missing_order_id");
  });
  it("blank order_id => unknown/missing_order_id", () => {
    const r = parseScalpOrderResponse({ order_id: "", fill_count: 0 }, REQ);
    assert.equal(r.outcome, "unknown");
    assert.equal(r.reason, "missing_order_id");
  });
  it("non-string order_id => unknown/missing_order_id", () => {
    const r = parseScalpOrderResponse({ order_id: 123, fill_count: 0 }, REQ);
    assert.equal(r.outcome, "unknown");
    assert.equal(r.reason, "missing_order_id");
  });

  // ── fill_count present + strictly parseable ─────────────────────────────
  it("missing fill_count => unknown/missing_fill_count (NEVER coerced to zero)", () => {
    const r = parseScalpOrderResponse({ order_id: "o" }, REQ);
    assert.equal(r.outcome, "unknown");
    assert.equal(r.reason, "missing_fill_count");
    assert.equal(r.orderId, "o", "independently trusted order identity must survive later parse failure");
    assert.equal(r.filledCount, null);
  });
  it("null fill_count => unknown/missing_fill_count", () => {
    const r = parseScalpOrderResponse({ order_id: "o", fill_count: null }, REQ);
    assert.equal(r.outcome, "unknown");
    assert.equal(r.reason, "missing_fill_count");
  });
  it("empty-string fill_count => unknown/unparseable_fill_count", () => {
    const r = parseScalpOrderResponse({ order_id: "o", fill_count: "" }, REQ);
    assert.equal(r.outcome, "unknown");
    assert.equal(r.reason, "unparseable_fill_count");
  });
  it("non-numeric string fill_count 'abc' => unknown", () => {
    const r = parseScalpOrderResponse({ order_id: "o", fill_count: "abc" }, REQ);
    assert.equal(r.outcome, "unknown");
    assert.equal(r.reason, "unparseable_fill_count");
  });
  it("partial-numeric string fill_count '1x' => unknown", () => {
    const r = parseScalpOrderResponse({ order_id: "o", fill_count: "1x" }, REQ);
    assert.equal(r.outcome, "unknown");
    assert.equal(r.reason, "unparseable_fill_count");
  });
  it("NaN / Infinity numeric fill_count => unknown", () => {
    assert.equal(parseScalpOrderResponse({ order_id: "o", fill_count: NaN }, REQ).reason, "unparseable_fill_count");
    assert.equal(parseScalpOrderResponse({ order_id: "o", fill_count: Infinity }, REQ).reason, "unparseable_fill_count");
    assert.equal(parseScalpOrderResponse({ order_id: "o", fill_count: -Infinity }, REQ).reason, "unparseable_fill_count");
  });
  it("negative fill_count (number and string) => unknown", () => {
    assert.equal(parseScalpOrderResponse({ order_id: "o", fill_count: -1 }, REQ).reason, "unparseable_fill_count");
    assert.equal(parseScalpOrderResponse({ order_id: "o", fill_count: "-1" }, REQ).reason, "unparseable_fill_count");
  });
  it("fractional FixedPointCount values are valid confirmed fills", () => {
    for (const fill_count of [1.5, "1.5", "0.25"]) {
      const r = parseScalpOrderResponse({ order_id: "o", fill_count, average_fill_price: 0.9 }, REQ);
      assert.equal(r.outcome, "confirmed_fill");
      assert.equal(r.filledCount, Number(fill_count));
    }
    assert.equal(
      parseScalpOrderResponse({ order_id: "o", fill_count: "1.234", average_fill_price: 0.9 }, REQ).reason,
      "unparseable_fill_count",
    );
  });
  it("whitespace-padded numeric string fill_count => unknown", () => {
    assert.equal(parseScalpOrderResponse({ order_id: "o", fill_count: " 1 " }, REQ).reason, "unparseable_fill_count");
  });

  // ── overfill ────────────────────────────────────────────────────────────
  it("fill_count > requestedCount => unknown/overfill_count", () => {
    const r = parseScalpOrderResponse({ order_id: "o", fill_count: 5, average_fill_price: 0.9 }, REQ);
    assert.equal(r.outcome, "unknown");
    assert.equal(r.reason, "overfill_count");
  });

  // ── validated zero ────────────────────────────────────────────────────
  it("zero fill (number 0) => zero_fill, avg may be absent", () => {
    const r = parseScalpOrderResponse({ order_id: "o", fill_count: 0 }, REQ);
    assert.equal(r.outcome, "zero_fill");
    assert.equal(r.reason, "zero_fill");
    assert.equal(r.filledCount, 0);
    assert.equal(r.orderId, "o");
    assert.equal(r.avgFillPrice, null);
  });
  it("zero fill (string '0') => zero_fill", () => {
    const r = parseScalpOrderResponse({ order_id: "o", fill_count: "0" }, REQ);
    assert.equal(r.outcome, "zero_fill");
    assert.equal(r.filledCount, 0);
  });
  it("zero fill string with fixed-point zeros '0.0' => zero_fill", () => {
    const r = parseScalpOrderResponse({ order_id: "o", fill_count: "0.00" }, REQ);
    assert.equal(r.outcome, "zero_fill");
    assert.equal(r.filledCount, 0);
  });

  // ── positive integral fill + valid avg ─────────────────────────────────
  it("positive integer fill (number) + valid avg => confirmed_fill", () => {
    const r = parseScalpOrderResponse({ order_id: "o", fill_count: 2, average_fill_price: 0.93 }, REQ);
    assert.equal(r.outcome, "confirmed_fill");
    assert.equal(r.filledCount, 2);
    assert.equal(r.avgFillPrice, 0.93);
    assert.equal(r.orderId, "o");
  });
  it("positive integer fill (string) + valid avg (string) => confirmed_fill", () => {
    const r = parseScalpOrderResponse({ order_id: "o", fill_count: "3", average_fill_price: "0.9200" }, REQ);
    assert.equal(r.outcome, "confirmed_fill");
    assert.equal(r.filledCount, 3);
    assert.equal(r.avgFillPrice, 0.92);
  });
  it("positive fill with fixed-point-integer string '2.0' + valid avg => confirmed_fill", () => {
    const r = parseScalpOrderResponse({ order_id: "o", fill_count: "2.0", average_fill_price: "0.5" }, REQ);
    assert.equal(r.outcome, "confirmed_fill");
    assert.equal(r.filledCount, 2);
  });

  // ── positive fill + missing/invalid avg => unknown ─────────────────────
  it("positive fill + MISSING avg => unknown/missing_avg_price", () => {
    const r = parseScalpOrderResponse({ order_id: "o", fill_count: 2 }, REQ);
    assert.equal(r.outcome, "unknown");
    assert.equal(r.reason, "missing_avg_price");
    assert.equal(r.orderId, "o");
    assert.equal(r.filledCount, 2);
  });
  it("positive fill + null avg => unknown/missing_avg_price", () => {
    const r = parseScalpOrderResponse({ order_id: "o", fill_count: 2, average_fill_price: null }, REQ);
    assert.equal(r.outcome, "unknown");
    assert.equal(r.reason, "missing_avg_price");
  });
  it("positive fill + non-numeric avg => unknown/invalid_avg_price", () => {
    assert.equal(parseScalpOrderResponse({ order_id: "o", fill_count: 2, average_fill_price: "abc" }, REQ).reason, "invalid_avg_price");
    assert.equal(parseScalpOrderResponse({ order_id: "o", fill_count: 2, average_fill_price: NaN }, REQ).reason, "invalid_avg_price");
    assert.equal(parseScalpOrderResponse({ order_id: "o", fill_count: 2, average_fill_price: Infinity }, REQ).reason, "invalid_avg_price");
  });
  it("positive fill + avg out of (0,1) boundaries => unknown/invalid_avg_price", () => {
    assert.equal(parseScalpOrderResponse({ order_id: "o", fill_count: 2, average_fill_price: 0 }, REQ).reason, "invalid_avg_price");
    assert.equal(parseScalpOrderResponse({ order_id: "o", fill_count: 2, average_fill_price: 1 }, REQ).reason, "invalid_avg_price");
    assert.equal(parseScalpOrderResponse({ order_id: "o", fill_count: 2, average_fill_price: 1.5 }, REQ).reason, "invalid_avg_price");
    assert.equal(parseScalpOrderResponse({ order_id: "o", fill_count: 2, average_fill_price: -0.1 }, REQ).reason, "invalid_avg_price");
  });

  it("never coerces a malformed fill to zero_fill", () => {
    // The core bug: malformed fill must NOT become zero_fill.
    for (const bad of [undefined, null, "", "abc", "1x", NaN, Infinity, -1, "1.234"]) {
      const r = parseScalpOrderResponse({ order_id: "o", fill_count: bad as unknown }, REQ);
      assert.notEqual(r.outcome, "zero_fill", `fill_count=${String(bad)} must not be zero_fill`);
      assert.equal(r.outcome, "unknown");
    }
  });
});

// ---------------------------------------------------------------------------
// validateScalpConfigPartial
// ---------------------------------------------------------------------------

describe("validateScalpConfigPartial", () => {
  it("accepts valid partial update", () => {
    const r = validateScalpConfigPartial({ globalBandMin: 0.91, globalBandMax: 0.98 });
    assert.ok(r.valid, JSON.stringify(r.errors));
  });

  it("rejects globalBandMin >= globalBandMax", () => {
    const r = validateScalpConfigPartial({ globalBandMin: 0.98, globalBandMax: 0.91 });
    assert.ok(!r.valid);
  });

  it("rejects globalBandMin >= globalBandMax when combined with current config", () => {
    // Current has max=0.91; setting min=0.95 makes effective min > max
    const r = validateScalpConfigPartial({ globalBandMin: 0.95 }, { globalBandMin: 0.85, globalBandMax: 0.91 });
    assert.ok(!r.valid);
  });

  it("rejects out-of-range band values", () => {
    const r1 = validateScalpConfigPartial({ globalBandMin: 0 });
    assert.ok(!r1.valid);
    const r2 = validateScalpConfigPartial({ globalBandMax: 1 });
    assert.ok(!r2.valid);
    const r3 = validateScalpConfigPartial({ globalBandMin: -0.1 });
    assert.ok(!r3.valid);
  });

  it("allows clearing the daily cap and any positive finite open cap", () => {
    assert.ok(validateScalpConfigPartial({ dailyCapDollars: null }).valid);
    const r = validateScalpConfigPartial({ openCapDollars: null });
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((error) => error.includes("openCapDollars")));
    assert.equal(validateScalpConfigPartial({ openCapDollars: 40 }).valid, true);
    assert.equal(validateScalpConfigPartial({ openCapDollars: 51 }).valid, true);
    assert.equal(validateScalpConfigPartial({ openCapDollars: 10_000 }).valid, true);
  });

  it("rejects invalid mode", () => {
    const r = validateScalpConfigPartial({ mode: "unknown" });
    assert.ok(!r.valid);
  });

  it("rejects invalid symbol in perMarketOverrides", () => {
    const r = validateScalpConfigPartial({
      perMarketOverrides: [{ symbol: "NOTACOIN", paused: true }],
    });
    assert.ok(!r.valid);
  });

  it("rejects per-market effective bandMin >= bandMax", () => {
    // Global is 0.91–0.98; override sets maxBand=0.90 but minBand defaults to 0.91 → invalid
    const r = validateScalpConfigPartial(
      { perMarketOverrides: [{ symbol: "BTC", maxBand: 0.90 }] },
      { globalBandMin: 0.91, globalBandMax: 0.98 },
    );
    assert.ok(!r.valid);
  });

  it("accepts valid perMarketOverrides", () => {
    const r = validateScalpConfigPartial({
      perMarketOverrides: [{ symbol: "BTC", minBand: 0.91, maxBand: 0.98, budgetDollars: 5, paused: false }],
    });
    assert.ok(r.valid, JSON.stringify(r.errors));
  });
});

// ---------------------------------------------------------------------------
// resolveEffectiveParams
// ---------------------------------------------------------------------------

describe("resolveEffectiveParams", () => {
  it("uses global defaults when no override", () => {
    const params = resolveEffectiveParams(DEFAULT_SCALP_CONFIG, "BTC", "BTC-TICKER");
    assert.equal(params.bandMin, DEFAULT_SCALP_CONFIG.globalBandMin);
    assert.equal(params.bandMax, DEFAULT_SCALP_CONFIG.globalBandMax);
    assert.equal(params.paused, false);
  });

  it("applies per-market overrides", () => {
    const config = {
      ...DEFAULT_SCALP_CONFIG,
      perMarketOverrides: [
        { symbol: "BTC", minBand: 0.92, maxBand: 0.97, paused: true, budgetDollars: 5, windowSeconds: 60 },
      ],
    };
    const params = resolveEffectiveParams(config, "btc", "BTC-TICKER");
    assert.equal(params.bandMin, 0.92);
    assert.equal(params.bandMax, 0.97);
    assert.equal(params.paused, true);
    assert.equal(params.budgetDollars, 5);
    assert.equal(params.finalWindowSeconds, 60);
    assert.equal(params.symbol, "BTC"); // normalized to uppercase
  });

  it("symbol match is case-insensitive", () => {
    const config = {
      ...DEFAULT_SCALP_CONFIG,
      perMarketOverrides: [{ symbol: "eth", paused: true }],
    };
    assert.ok(resolveEffectiveParams(config, "ETH", "").paused);
  });
});

// ---------------------------------------------------------------------------
// Full NO contract end-to-end example
// ---------------------------------------------------------------------------

describe("NO contract end-to-end", () => {
  it("correctly maps: yesAsk=0.08, yesBid=0.07 → noAsk=0.93 → side=no → limitPrice=0.07 → NO win P&L=+0.07", () => {
    // STEP 1: Validate orderbook
    // yesBid=0.07, yesAsk=0.08: valid two-sided book (bid < ask)
    // noAsk = 1 - yesBid = 0.93: in band [0.91, 0.98]
    const q = validateOrderbookQuote(
      { yesAsk: 0.08, yesBid: 0.07 },
      "BTC-20240101T120000",
      "2024-01-01T12:00:00Z",
    );
    assert.ok(q, "quote should be valid: yesBid(0.07) < yesAsk(0.08)");
    assert.equal(q.yesAsk, 0.08);
    assert.equal(q.yesBid, 0.07);
    // noAsk = 1 - yesBid = 0.93
    assert.ok(Math.abs(q.noAsk - 0.93) < 0.0001);

    // STEP 2: Select side
    const match = selectScalpSide(q.yesAsk, q.noAsk, 0.91, 0.98);
    assert.ok(match);
    assert.equal(match.side, "no");
    assert.ok(Math.abs(match.winningAsk - 0.93) < 0.0001, `winningAsk expected ~0.93 got ${match.winningAsk}`);

    // STEP 3: Contract count uses the worst acceptable cost, not the quote.
    const sized = sizeOrderWithinReservedBudget(2.00, match.winningAsk, 0.98);
    assert.equal(sized.ok, true);
    assert.equal(sized.contractCount, 2);

    // STEP 4: limitPrice accepts any in-band NO cost up to 0.98.
    const limitPrice = computeLimitPrice("no", 0.98);
    assert.equal(limitPrice, 0.02);

    // STEP 5: Winning-contract cost from fill (avgFillPrice=0.07, YES-side)
    const wc = winningCostFromFill("no", 0.07);
    assert.ok(Math.abs(wc - 0.93) < 0.0001, `winningContractCost expected 0.93 got ${wc}`);

    // STEP 6: P&L — settled NO (NO wins)
    const pnlWin = computeScalpPnl("live", "no", 2, 0.07, "no");
    // +avgFillPrice * filledCount = +0.07 * 2 = +0.14
    assert.ok(Math.abs(pnlWin - 0.14) < 0.0001, `Expected +0.14 got ${pnlWin}`);

    // STEP 7: P&L — settled YES (NO loses)
    const pnlLoss = computeScalpPnl("live", "no", 2, 0.07, "yes");
    // -(1 - avgFillPrice) * filledCount = -0.93 * 2 = -1.86
    assert.ok(Math.abs(pnlLoss - (-1.86)) < 0.0001, `Expected -1.86 got ${pnlLoss}`);

    // STEP 8: Band check on fill
    assert.ok(isFillWithinBand("no", 0.07, 0.91, 0.98)); // wc=0.93 ∈ [0.91, 0.98]
  });
});

// ---------------------------------------------------------------------------
// Execution-risk snapshot: pin-and-compare (fail-closed on mid-flight change)
// ---------------------------------------------------------------------------

const baseCfg = (): RiskConfigLike => ({
  enabled: true,
  mode: "live",
  dailyCapDollars: 100,
  openCapDollars: 50,
  freefallGuardEnabled: true,
  freefallLookbackSeconds: 30,
  freefallThresholdPct: 0.5,
  targetProximityGuardEnabled: true,
  targetProximityThresholdPct: 0.05,
});
const baseParams = (): RiskParamsLike => ({
  bandMin: 0.91,
  bandMax: 0.98,
  finalWindowSeconds: 120,
  budgetDollars: 2,
  paused: false,
});
const baseIdentity = () => ({ symbol: "BTC", windowKey: "WK-1", ticker: "T-1", closeTime: "2025-01-01T00:00:00Z" });

describe("buildExecutionRiskSnapshot", () => {
  it("captures budgetDollars from effective params (reserved amount)", () => {
    const s = buildExecutionRiskSnapshot(baseCfg(), { ...baseParams(), budgetDollars: 3.5 }, baseIdentity());
    assert.equal(s.budgetDollars, 3.5);
  });
  it("captures caps, band, window, guards, identity, mode, enabled", () => {
    const s = buildExecutionRiskSnapshot(baseCfg(), baseParams(), baseIdentity());
    assert.equal(s.dailyCapDollars, 100);
    assert.equal(s.openCapDollars, 50);
    assert.equal(s.bandMin, 0.91);
    assert.equal(s.bandMax, 0.98);
    assert.equal(s.finalWindowSeconds, 120);
    assert.equal(s.freefallGuardEnabled, true);
    assert.equal(s.freefallLookbackSeconds, 30);
    assert.equal(s.freefallThresholdPct, 0.5);
    assert.equal(s.targetProximityGuardEnabled, true);
    assert.equal(s.targetProximityThresholdPct, 0.05);
    assert.equal(s.ticker, "T-1");
    assert.equal(s.closeTime, "2025-01-01T00:00:00Z");
    assert.equal(s.mode, "live");
    assert.equal(s.enabled, true);
  });
  it("is frozen (immutable)", () => {
    const s = buildExecutionRiskSnapshot(baseCfg(), baseParams(), baseIdentity());
    assert.ok(Object.isFrozen(s));
    assert.throws(() => { (s as any).budgetDollars = 99; });
  });
});

describe("compareRiskSnapshot (fail-closed diff)", () => {
  const snap = () => buildExecutionRiskSnapshot(baseCfg(), baseParams(), baseIdentity());

  it("unchanged snapshot => allowed", () => {
    const d = compareRiskSnapshot(snap(), baseCfg(), baseParams(), baseIdentity());
    assert.equal(d.unchanged, true);
    assert.deepEqual(d.changedFields, []);
    assert.equal(d.reason, null);
  });

  it("budget INCREASE mid-flight => rejected", () => {
    const d = compareRiskSnapshot(snap(), baseCfg(), { ...baseParams(), budgetDollars: 3 }, baseIdentity());
    assert.equal(d.unchanged, false);
    assert.ok(d.changedFields.includes("budgetDollars"));
  });
  it("budget DECREASE mid-flight => rejected", () => {
    const d = compareRiskSnapshot(snap(), baseCfg(), { ...baseParams(), budgetDollars: 1 }, baseIdentity());
    assert.equal(d.unchanged, false);
    assert.ok(d.changedFields.includes("budgetDollars"));
  });

  it("daily cap change => rejected", () => {
    const d = compareRiskSnapshot(snap(), { ...baseCfg(), dailyCapDollars: 200 }, baseParams(), baseIdentity());
    assert.ok(d.changedFields.includes("dailyCapDollars"));
  });
  it("open cap change => rejected", () => {
    const d = compareRiskSnapshot(snap(), { ...baseCfg(), openCapDollars: 40 }, baseParams(), baseIdentity());
    assert.ok(d.changedFields.includes("openCapDollars"));
  });
  it("nullable daily cap with unchanged finite open cap => allowed", () => {
    const cfg = { ...baseCfg(), dailyCapDollars: null };
    const s = buildExecutionRiskSnapshot(cfg, baseParams(), baseIdentity());
    const d = compareRiskSnapshot(s, cfg, baseParams(), baseIdentity());
    assert.equal(d.unchanged, true);
  });

  it("bandMin change => rejected", () => {
    const d = compareRiskSnapshot(snap(), baseCfg(), { ...baseParams(), bandMin: 0.9 }, baseIdentity());
    assert.ok(d.changedFields.includes("bandMin"));
  });
  it("bandMax change => rejected", () => {
    const d = compareRiskSnapshot(snap(), baseCfg(), { ...baseParams(), bandMax: 0.99 }, baseIdentity());
    assert.ok(d.changedFields.includes("bandMax"));
  });
  it("finalWindowSeconds change => rejected", () => {
    const d = compareRiskSnapshot(snap(), baseCfg(), { ...baseParams(), finalWindowSeconds: 60 }, baseIdentity());
    assert.ok(d.changedFields.includes("finalWindowSeconds"));
  });

  it("freefall enabled toggle => rejected", () => {
    const d = compareRiskSnapshot(snap(), { ...baseCfg(), freefallGuardEnabled: false }, baseParams(), baseIdentity());
    assert.ok(d.changedFields.includes("freefallGuardEnabled"));
  });
  it("freefall lookback change => rejected", () => {
    const d = compareRiskSnapshot(snap(), { ...baseCfg(), freefallLookbackSeconds: 45 }, baseParams(), baseIdentity());
    assert.ok(d.changedFields.includes("freefallLookbackSeconds"));
  });
  it("freefall threshold change => rejected", () => {
    const d = compareRiskSnapshot(snap(), { ...baseCfg(), freefallThresholdPct: 0.7 }, baseParams(), baseIdentity());
    assert.ok(d.changedFields.includes("freefallThresholdPct"));
  });
  it("target proximity toggle change => rejected", () => {
    const d = compareRiskSnapshot(snap(), { ...baseCfg(), targetProximityGuardEnabled: false }, baseParams(), baseIdentity());
    assert.ok(d.changedFields.includes("targetProximityGuardEnabled"));
  });
  it("target proximity threshold change => rejected", () => {
    const d = compareRiskSnapshot(snap(), { ...baseCfg(), targetProximityThresholdPct: 0.1 }, baseParams(), baseIdentity());
    assert.ok(d.changedFields.includes("targetProximityThresholdPct"));
  });

  it("enabled toggle => rejected", () => {
    const d = compareRiskSnapshot(snap(), { ...baseCfg(), enabled: false }, baseParams(), baseIdentity());
    assert.ok(d.changedFields.includes("enabled"));
  });
  it("mode change => rejected", () => {
    const d = compareRiskSnapshot(snap(), { ...baseCfg(), mode: "paper" }, baseParams(), baseIdentity());
    assert.ok(d.changedFields.includes("mode"));
  });
  it("paused toggle => rejected", () => {
    const d = compareRiskSnapshot(snap(), baseCfg(), { ...baseParams(), paused: true }, baseIdentity());
    assert.ok(d.changedFields.includes("paused"));
  });

  it("ticker identity change => rejected", () => {
    const d = compareRiskSnapshot(snap(), baseCfg(), baseParams(), { ...baseIdentity(), ticker: "T-2" });
    assert.ok(d.changedFields.includes("ticker"));
  });
  it("closeTime identity change => rejected", () => {
    const d = compareRiskSnapshot(snap(), baseCfg(), baseParams(), { ...baseIdentity(), closeTime: "2025-01-01T00:05:00Z" });
    assert.ok(d.changedFields.includes("closeTime"));
  });
  it("windowKey identity change => rejected", () => {
    const d = compareRiskSnapshot(snap(), baseCfg(), baseParams(), { ...baseIdentity(), windowKey: "WK-2" });
    assert.ok(d.changedFields.includes("windowKey"));
  });

  it("multiple simultaneous changes all reported; reason is first", () => {
    const d = compareRiskSnapshot(
      snap(),
      { ...baseCfg(), enabled: false, dailyCapDollars: 5 },
      { ...baseParams(), budgetDollars: 9 },
      baseIdentity(),
    );
    assert.equal(d.unchanged, false);
    assert.ok(d.changedFields.includes("enabled"));
    assert.ok(d.changedFields.includes("budgetDollars"));
    assert.ok(d.changedFields.includes("dailyCapDollars"));
    assert.ok(d.reason?.startsWith("risk_changed:"));
  });
});

// ---------------------------------------------------------------------------
// Sizing within reserved budget: exposure can never exceed reserved amount
// ---------------------------------------------------------------------------

describe("maxSubmitExposure", () => {
  it("count * cappedAsk", () => {
    assert.ok(Math.abs(maxSubmitExposure(3, 0.9) - 2.7) < 1e-9);
  });
  it("zero/negative inputs => 0", () => {
    assert.equal(maxSubmitExposure(0, 0.9), 0);
    assert.equal(maxSubmitExposure(3, 0), 0);
    assert.equal(maxSubmitExposure(-1, 0.9), 0);
    assert.equal(maxSubmitExposure(NaN, 0.9), 0);
  });
});

describe("sizeOrderWithinReservedBudget", () => {
  it("sizes against the worst acceptable band cost, not the observed quote", () => {
    // observed=0.90, cap=0.98 → floor(2/0.98)=2 → exposure=1.96 <= 2
    const r = sizeOrderWithinReservedBudget(2, 0.9, 0.98);
    assert.equal(r.ok, true);
    assert.equal(r.contractCount, 2);
    assert.equal(r.maxWinningCost, 0.98);
    assert.ok(r.maxExposure <= 2, `exposure ${r.maxExposure} must be <= 2`);
    assert.ok(Math.abs(r.maxExposure - 1.96) < 1e-9);
  });

  it("fails closed if an out-of-band quote reaches sizing", () => {
    const r = sizeOrderWithinReservedBudget(2, 0.99, 0.95);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "winning_ask_above_band_max");
  });

  it("keeps YES and NO order counts inside a 95-cent execution cap", () => {
    const yes = sizeOrderWithinReservedBudget(5, 0.92, 0.95);
    const no = sizeOrderWithinReservedBudget(5, 0.91, 0.95);
    assert.equal(yes.contractCount, 5);
    assert.equal(no.contractCount, 5);
    assert.equal(yes.maxWinningCost, 0.95);
    assert.equal(no.maxWinningCost, 0.95);
    assert.equal(computeLimitPrice("yes", yes.maxWinningCost), 0.95);
    assert.equal(computeLimitPrice("no", no.maxWinningCost), 0.05);
    assert.ok(yes.maxExposure <= 5);
    assert.ok(no.maxExposure <= 5);
  });

  it("EXPOSURE NEVER EXCEEDS reserved across a sweep of budgets/asks", () => {
    for (let reserved = 0.5; reserved <= 25; reserved += 0.37) {
      for (let ask = 0.05; ask < 0.99; ask += 0.031) {
        const r = sizeOrderWithinReservedBudget(reserved, ask, 0.98);
        if (r.ok) {
          assert.ok(
            r.maxExposure <= reserved + 1e-9,
            `exposure ${r.maxExposure} exceeded reserved ${reserved} (count=${r.contractCount} cap=${r.maxWinningCost})`,
          );
          assert.ok(r.contractCount >= 1);
        }
      }
    }
  });

  it("reserved too small for one contract => not ok (contract_count_zero)", () => {
    // reserved=0.5, cap=0.98 → floor(0.5/0.98)=0
    const r = sizeOrderWithinReservedBudget(0.5, 0.9, 0.98);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "contract_count_zero");
    assert.equal(r.contractCount, 0);
    assert.equal(r.maxExposure, 0);
  });

  it("invalid inputs fail closed", () => {
    assert.equal(sizeOrderWithinReservedBudget(0, 0.9, 0.98).reason, "reserved_budget_invalid");
    assert.equal(sizeOrderWithinReservedBudget(-1, 0.9, 0.98).reason, "reserved_budget_invalid");
    assert.equal(sizeOrderWithinReservedBudget(2, 0, 0.98).reason, "winning_ask_invalid");
    assert.equal(sizeOrderWithinReservedBudget(2, 1, 0.98).reason, "winning_ask_invalid");
    assert.equal(sizeOrderWithinReservedBudget(2, 0.9, 0).reason, "band_max_invalid");
    assert.equal(sizeOrderWithinReservedBudget(2, 0.9, 1).reason, "band_max_invalid");
  });

  it("a decreased reserved budget produces a smaller-or-equal contract count", () => {
    const big = sizeOrderWithinReservedBudget(10, 0.9, 0.98);
    const small = sizeOrderWithinReservedBudget(2, 0.9, 0.98);
    assert.ok(big.contractCount >= small.contractCount);
    // Sizing against the SMALLER (reserved) budget keeps exposure bounded.
    assert.ok(small.maxExposure <= 2);
  });
});

// ---------------------------------------------------------------------------
// parseScalpConfigPatch — strict typed parsing + normalization (fail-closed)
// ---------------------------------------------------------------------------

describe("parseScalpConfigPatch", () => {
  const errsOf = (r: ReturnType<typeof parseScalpConfigPatch>): string[] =>
    r.ok ? [] : r.errors;

  it("rejects non-object bodies", () => {
    for (const bad of [null, undefined, 42, "x", [] as unknown]) {
      const r = parseScalpConfigPatch(bad);
      assert.equal(r.ok, false);
    }
  });

  it("rejects enabled:'false' (string, not boolean)", () => {
    const r = parseScalpConfigPatch({ enabled: "false" });
    assert.equal(r.ok, false);
    assert.ok(errsOf(r).some((e) => e.includes("enabled")));
  });

  it("accepts enabled:false (real boolean)", () => {
    const r = parseScalpConfigPatch({ enabled: false });
    assert.equal(r.ok, true);
    assert.deepEqual(r.ok && r.value, { enabled: false });
  });

  it("accepts a real circuit-breaker enforcement boolean and rejects coercion", () => {
    assert.deepEqual(
      parseScalpConfigPatch({ circuitBreakerEnabled: false }),
      { ok: true, value: { circuitBreakerEnabled: false } },
    );
    assert.equal(parseScalpConfigPatch({ circuitBreakerEnabled: "false" }).ok, false);
  });

  it("rejects freefallGuardEnabled non-boolean", () => {
    const r = parseScalpConfigPatch({ freefallGuardEnabled: 1 });
    assert.equal(r.ok, false);
    assert.ok(errsOf(r).some((e) => e.includes("freefallGuardEnabled")));
  });

  it("accepts a real target proximity toggle and rejects coercion", () => {
    assert.deepEqual(
      parseScalpConfigPatch({ targetProximityGuardEnabled: false }),
      { ok: true, value: { targetProximityGuardEnabled: false } },
    );
    assert.equal(parseScalpConfigPatch({ targetProximityGuardEnabled: "false" }).ok, false);
  });

  it("rejects invalid mode", () => {
    const r = parseScalpConfigPatch({ mode: "PAPER" });
    assert.equal(r.ok, false);
    assert.ok(errsOf(r).some((e) => e.includes("mode")));
  });
  it("accepts mode exactly 'live'", () => {
    const r = parseScalpConfigPatch({ mode: "live" });
    assert.equal(r.ok, true);
    assert.deepEqual(r.ok && r.value, { mode: "live" });
  });

  it("rejects numeric STRING for a numeric field", () => {
    const r = parseScalpConfigPatch({ budgetDollars: "2" });
    assert.equal(r.ok, false);
    assert.ok(errsOf(r).some((e) => e.includes("budgetDollars")));
  });

  it("rejects NaN and Infinity numeric values (pure helper rejection)", () => {
    assert.equal(parseScalpConfigPatch({ budgetDollars: NaN }).ok, false);
    assert.equal(parseScalpConfigPatch({ budgetDollars: Infinity }).ok, false);
    assert.equal(parseScalpConfigPatch({ freefallThresholdPct: -Infinity }).ok, false);
    assert.equal(parseScalpConfigPatch({ globalBandMin: NaN }).ok, false);
  });

  it("rejects out-of-range numbers", () => {
    assert.equal(parseScalpConfigPatch({ globalBandMin: 0 }).ok, false);
    assert.equal(parseScalpConfigPatch({ globalBandMax: 1 }).ok, false);
    assert.equal(parseScalpConfigPatch({ finalWindowSeconds: 0 }).ok, false);
    assert.equal(parseScalpConfigPatch({ finalWindowSeconds: 901 }).ok, false);
    assert.equal(parseScalpConfigPatch({ budgetDollars: 0 }).ok, false);
    assert.equal(parseScalpConfigPatch({ budgetDollars: 1001 }).ok, false);
    assert.equal(parseScalpConfigPatch({ freefallLookbackSeconds: 601 }).ok, false);
    assert.equal(parseScalpConfigPatch({ freefallThresholdPct: 0 }).ok, false);
    assert.equal(parseScalpConfigPatch({ targetProximityThresholdPct: 0 }).ok, false);
    assert.equal(parseScalpConfigPatch({ targetProximityThresholdPct: 10.01 }).ok, false);
  });

  it("accepts valid in-range numbers and returns them typed", () => {
    const r = parseScalpConfigPatch({
      globalBandMin: 0.9, globalBandMax: 0.97, finalWindowSeconds: 100,
      budgetDollars: 3, freefallLookbackSeconds: 20, freefallThresholdPct: 0.4,
      targetProximityThresholdPct: 0.05,
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.ok && r.value, {
      globalBandMin: 0.9, globalBandMax: 0.97, finalWindowSeconds: 100,
      budgetDollars: 3, freefallLookbackSeconds: 20, freefallThresholdPct: 0.4,
      targetProximityThresholdPct: 0.05,
    });
  });

  it("rejects globalBandMin >= globalBandMax when both provided", () => {
    const r = parseScalpConfigPatch({ globalBandMin: 0.95, globalBandMax: 0.9 });
    assert.equal(r.ok, false);
    assert.ok(errsOf(r).some((e) => e.includes("less than")));
  });

  it("caps: daily accepts null while open exposure honors larger operator values", () => {
    assert.deepEqual(parseScalpConfigPatch({ dailyCapDollars: null }), { ok: true, value: { dailyCapDollars: null } });
    assert.deepEqual(parseScalpConfigPatch({ openCapDollars: 40 }), { ok: true, value: { openCapDollars: 40 } });
    assert.deepEqual(parseScalpConfigPatch({ openCapDollars: 50 }), { ok: true, value: { openCapDollars: 50 } });
    assert.deepEqual(parseScalpConfigPatch({ openCapDollars: 500 }), { ok: true, value: { openCapDollars: 500 } });
    assert.equal(parseScalpConfigPatch({ openCapDollars: null }).ok, false);
    assert.equal(parseScalpConfigPatch({ openCapDollars: -1 }).ok, false);
    assert.equal(parseScalpConfigPatch({ dailyCapDollars: "50" }).ok, false);
    assert.equal(parseScalpConfigPatch({ dailyCapDollars: 0 }).ok, false);
    assert.equal(parseScalpConfigPatch({ openCapDollars: NaN }).ok, false);
  });

  it("rejects unknown top-level field", () => {
    const r = parseScalpConfigPatch({ enabled: true, bogus: 1 });
    assert.equal(r.ok, false);
    assert.ok(errsOf(r).some((e) => e.includes("bogus")));
  });

  it("rejects internal circuitBreaker / circuitBreakerReason fields", () => {
    const r1 = parseScalpConfigPatch({ circuitBreaker: false });
    assert.equal(r1.ok, false);
    assert.ok(errsOf(r1).some((e) => e.includes("circuitBreaker")));
    const r2 = parseScalpConfigPatch({ circuitBreakerReason: "x" });
    assert.equal(r2.ok, false);
    assert.ok(errsOf(r2).some((e) => e.includes("circuitBreakerReason")));
  });

  // ── perMarketOverrides ──
  it("rejects perMarketOverrides that is not an array", () => {
    assert.equal(parseScalpConfigPatch({ perMarketOverrides: {} }).ok, false);
  });

  it("normalizes override symbol to uppercase and requires supported symbol", () => {
    const r = parseScalpConfigPatch({ perMarketOverrides: [{ symbol: "btc", paused: true }] });
    assert.equal(r.ok, true);
    assert.deepEqual(r.ok && r.value.perMarketOverrides, [{ symbol: "BTC", paused: true }]);
    assert.equal(parseScalpConfigPatch({ perMarketOverrides: [{ symbol: "FAKE" }] }).ok, false);
  });

  it("rejects nested override boolean-as-string and numeric-as-string", () => {
    assert.equal(parseScalpConfigPatch({ perMarketOverrides: [{ symbol: "BTC", paused: "true" }] }).ok, false);
    assert.equal(parseScalpConfigPatch({ perMarketOverrides: [{ symbol: "BTC", minBand: "0.9" }] }).ok, false);
    assert.equal(parseScalpConfigPatch({ perMarketOverrides: [{ symbol: "BTC", budgetDollars: "5" }] }).ok, false);
  });

  it("rejects unknown nested override key", () => {
    const r = parseScalpConfigPatch({ perMarketOverrides: [{ symbol: "BTC", nope: 1 }] });
    assert.equal(r.ok, false);
    assert.ok(errsOf(r).some((e) => e.includes("nope")));
  });

  it("rejects duplicate override symbols (case-insensitive)", () => {
    const r = parseScalpConfigPatch({ perMarketOverrides: [{ symbol: "BTC" }, { symbol: "btc" }] });
    assert.equal(r.ok, false);
    assert.ok(errsOf(r).some((e) => e.toLowerCase().includes("duplicate")));
  });

  it("rejects nested/malformed (non-object) override entry", () => {
    assert.equal(parseScalpConfigPatch({ perMarketOverrides: ["BTC"] }).ok, false);
    assert.equal(parseScalpConfigPatch({ perMarketOverrides: [null] }).ok, false);
  });

  it("preserves explicit null in override numeric fields (clear semantics)", () => {
    const r = parseScalpConfigPatch({ perMarketOverrides: [{ symbol: "ETH", minBand: null, budgetDollars: null }] });
    assert.equal(r.ok, true);
    assert.deepEqual(r.ok && r.value.perMarketOverrides, [{ symbol: "ETH", minBand: null, budgetDollars: null }]);
  });

  it("rejects override minBand >= maxBand when both concrete", () => {
    const r = parseScalpConfigPatch({ perMarketOverrides: [{ symbol: "BTC", minBand: 0.95, maxBand: 0.9 }] });
    assert.equal(r.ok, false);
  });

  it("accepts a full valid patch and returns only present fields", () => {
    const r = parseScalpConfigPatch({
      enabled: true, mode: "paper", budgetDollars: 2.5,
      dailyCapDollars: 100, openCapDollars: 50,
      perMarketOverrides: [{ symbol: "SOL", paused: false, windowSeconds: 60 }],
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.ok && r.value, {
      enabled: true, mode: "paper", budgetDollars: 2.5,
      dailyCapDollars: 100, openCapDollars: 50,
      perMarketOverrides: [{ symbol: "SOL", paused: false, windowSeconds: 60 }],
    });
  });

  it("empty object is a valid no-op patch", () => {
    assert.deepEqual(parseScalpConfigPatch({}), { ok: true, value: {} });
  });
});

describe("describeScalpCircuitBreakerReason", () => {
  it("explains an out-of-band fill in plain English", () => {
    assert.equal(
      describeScalpCircuitBreakerReason("fill_outside_band:BTC:yes:cost=0.9912:band=[0.91,0.98]"),
      "BTC YES filled at 99.12¢, outside your allowed 91¢–98¢ range.",
    );
  });

  it("explains an above-ceiling fill as an adverse cost breach", () => {
    assert.equal(
      describeScalpCircuitBreakerReason("fill_above_ceiling:GOLD:no:cost=0.9600:ceiling=0.95"),
      "GOLD NO filled at 96¢, above your 95¢ winning-cost ceiling.",
    );
  });

  it("explains uncertain order outcomes without exposing machine codes", () => {
    const message = describeScalpCircuitBreakerReason("scalp_submit_threw:ETH:2026-08-21T15:30");
    assert.equal(message, "Kalshi did not confirm whether the ETH order was accepted or filled.");
    assert.doesNotMatch(message, /scalp_submit_threw|_/);
  });

  it("uses a readable fallback for legacy or unknown reasons", () => {
    const message = describeScalpCircuitBreakerReason("legacy_internal_code");
    assert.match(message, /live-order safety problem/i);
    assert.doesNotMatch(message, /legacy_internal_code|_/);
  });
});

describe("preserveNewerScalpBreakerState", () => {
  it("allows an intentional reset when no newer event occurred", () => {
    const proposed: { enabled: boolean; circuitBreaker: boolean; circuitBreakerReason: string | null } = {
      enabled: true, circuitBreaker: false, circuitBreakerReason: null,
    };
    const latest = { circuitBreaker: true, circuitBreakerReason: "old_event" };
    assert.deepEqual(
      preserveNewerScalpBreakerState(proposed, latest, 4, 4),
      proposed,
    );
  });

  it("preserves a breaker event that arrived during an async config save", () => {
    const proposed: { enabled: boolean; circuitBreaker: boolean; circuitBreakerReason: string | null } = {
      enabled: false, circuitBreaker: false, circuitBreakerReason: null,
    };
    const latest = { circuitBreaker: true, circuitBreakerReason: "new_event" };
    assert.deepEqual(
      preserveNewerScalpBreakerState(proposed, latest, 4, 5),
      { enabled: false, circuitBreaker: true, circuitBreakerReason: "new_event" },
    );
  });
});

describe("persistCircuitBreakerWithPolicy", () => {
  it("rejects a durable breaker write failure before exposure can be released", async () => {
    const failure = new Error("breaker config unavailable");
    let failureObserved: unknown = null;
    let releaseReached = false;

    await assert.rejects(
      async () => {
        await persistCircuitBreakerWithPolicy(
          async () => { throw failure; },
          (error) => { failureObserved = error; },
          true,
        );
        releaseReached = true;
      },
      failure,
    );
    assert.equal(failureObserved, failure);
    assert.equal(releaseReached, false);
  });

  it("retains the existing background-retry behavior for non-strict callers", async () => {
    const failure = new Error("breaker config unavailable");
    let failureObserved: unknown = null;
    await persistCircuitBreakerWithPolicy(
      async () => { throw failure; },
      (error) => { failureObserved = error; },
      false,
    );
    assert.equal(failureObserved, failure);
  });
});

// ---------------------------------------------------------------------------
// Static wiring: prove the in-flight snapshot pin + final freefall + final
// balance run BEFORE any order intent / placeOrder in the execution path.
// ---------------------------------------------------------------------------

describe("execution wiring (static source assertions)", () => {
  const svc = (() => {
    const here = dirname(fileURLToPath(import.meta.url));
    return readFileSync(join(here, "kalshi-scalper-service.ts"), "utf8");
  })();

  const exch = (() => {
    const here = dirname(fileURLToPath(import.meta.url));
    return readFileSync(join(here, "kalshi-scalper-exchange.ts"), "utf8");
  })();

  const idx = (needle: string): number => svc.indexOf(needle);

  // ── Scalper-owned exchange boundary (never uses protected placeOrder) ──────

  it("service does NOT import placeOrder from kalshi-trader (read-only trader use)", () => {
    // The trader import line must not include placeOrder.
    const traderImport = /import\s*\{([^}]*)\}\s*from\s*"\.\/kalshi-trader\.ts"/.exec(svc);
    assert.ok(traderImport, "expected a kalshi-trader import");
    const names = traderImport![1];
    assert.ok(!/\bplaceOrder\b/.test(names), "service must not import placeOrder");
    // Only balance/settlement reads are imported.
    assert.match(names, /getBalance/);
    assert.match(names, /fetchKalshiMarketResult/);
  });

  it("service never calls placeOrder(...) anywhere", () => {
    assert.ok(!/\bplaceOrder\(/.test(svc), "service must not call placeOrder(");
  });

  it("service imports and calls the strict scalper submission", () => {
    assert.match(svc, /import\s*\{[\s\S]*?\bplaceScalpOrderStrict\b[\s\S]*?\}\s*from\s*"\.\/kalshi-scalper-exchange\.ts"/);
    assert.match(svc, /await runtime\.placeScalpOrderStrict\(/);
  });

  it("persists a caller-generated client order id before passing it unchanged to Kalshi", () => {
    const clientId = idx('const clientOrderId = mode === "live" ? crypto.randomUUID() : null');
    const intent = idx("await runtime.insertScalpOrderIntent(orderRecord)");
    const submit = idx("const result = await runtime.placeScalpOrderStrict");
    assert.ok(clientId >= 0 && clientId < intent && intent < submit);
    assert.match(svc.slice(submit, submit + 500), /clientOrderId: clientOrderId!/);
    assert.match(exch, /client_order_id:\s*clientOrderId/);
    assert.ok(!/const clientOrderId = crypto\.randomUUID\(\)/.test(exch));
  });

  it("reconciles startup submitting rows before latching them unknown", () => {
    const start = idx("async function _recoverSubmittingOrders");
    const end = idx("export function getScalpConfig");
    const recovery = svc.slice(start, end);
    assert.match(recovery, /_fetchScalpReconciliation\(order\)/);
    assert.match(recovery, /_applyScalpReconciliation\(order, reconciliation\)/);
    assert.ok(
      recovery.indexOf("_fetchScalpReconciliation(order)")
        < recovery.indexOf('"unknown_fill_state_after_crash"'),
    );
  });

  it("deduplicates unresolved order and reservation rows by attempt identity", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const db = readFileSync(join(here, "kalshi-scalper-db.ts"), "utf8");
    const countStart = db.indexOf("export async function countUnresolvedLiveAttempts");
    const countEnd = db.indexOf("export async function getUnresolvedLiveAttempts", countStart);
    const countSql = db.slice(countStart, countEnd);
    assert.match(countSql, /SELECT mode, symbol, window_key[\s\S]*?UNION[\s\S]*?SELECT mode, symbol, window_key/);
    assert.ok(!/\+\s*\(SELECT COUNT/.test(countSql), "must not add matching order and reservation rows");
  });

  it("recent execution diagnostics exclude never-submitted and in-flight intents", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const db = readFileSync(join(here, "kalshi-scalper-db.ts"), "utf8");
    const start = db.indexOf("export async function getRecentScalpReservations");
    const end = db.indexOf("// Atomic finalize-and-release", start);
    const recent = db.slice(start, end);
    const lateralStart = recent.indexOf("LEFT JOIN LATERAL");
    const lateralEnd = recent.indexOf(") latest_order ON TRUE", lateralStart);
    const latestProvenOrder = recent.slice(lateralStart, lateralEnd);
    assert.match(latestProvenOrder, /o\.status IN \('filled', 'zero_fill'\)/);
    assert.match(latestProvenOrder, /o\.status = 'paper'/);
    assert.ok(!latestProvenOrder.includes("'submitting'"));
    assert.ok(!latestProvenOrder.includes("'skipped'"));
    assert.ok(!latestProvenOrder.includes("'unknown'"));
  });

  it("reconciled fills classify favorable improvements separately and trip only above-ceiling breaches before release", () => {
    const start = idx("async function _applyScalpReconciliation");
    const end = svc.indexOf("async function _evaluateCandidate", start);
    const reconciliation = svc.slice(start, end);
    const bandCheck = reconciliation.indexOf("classifyScalpFillAgainstBand(");
    const adverseGate = reconciliation.indexOf('fillBand?.classification === "adverse_limit_breach"');
    const breaker = reconciliation.indexOf("await _tripCircuitBreaker(breakerReason, true)");
    const release = reconciliation.indexOf("await reconcileScalpOrderAndReleaseReservation(");
    assert.ok(
      bandCheck >= 0
        && bandCheck < adverseGate
        && adverseGate < breaker
        && breaker < release,
    );
    assert.match(reconciliation, /favorable_price_improvement/);
    assert.match(reconciliation, /incident,\s*\}\);/);
  });

  it("immediate fills use the shared classification and breaker only for adverse breaches", () => {
    const start = idx("// ── (2) CONFIRMED FILL:");
    const end = svc.indexOf("/**\n * Post-submit persistence failure handler", start);
    const immediateFill = svc.slice(start, end);
    assert.match(immediateFill, /classifyScalpFillAgainstBand\(/);
    assert.match(
      immediateFill,
      /fillBand\.classification === "adverse_limit_breach"[\s\S]*?_tripCircuitBreaker\(/,
    );
  });

  it("final sibling reconciliation derives reservation status from all order outcomes", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const db = readFileSync(join(here, "kalshi-scalper-db.ts"), "utf8");
    const start = db.indexOf("export async function reconcileScalpOrderAndReleaseReservation");
    const end = db.indexOf("function rowToScalpOrder", start);
    const reconciliation = db.slice(start, end);
    assert.match(reconciliation, /BOOL_OR\(status = 'filled'\)/);
    assert.match(reconciliation, /hasFill \? "filled" : "zero_fill"/);
  });

  it("live path uses the strict parser outcome (not zero-coerced) and paper uses classify with requestedCount", () => {
    assert.match(svc, /liveOutcome = result\.outcome/);
    assert.match(svc, /classifyPlaceOrderResult\(\{\s*filledCount,\s*avgFillPrice,\s*requestedCount: contractCount\s*\}\)/);
  });

  it("exchange module does NOT import or call placeOrder from the trader", () => {
    assert.ok(!/from\s*"\.\/kalshi-trader/.test(exch), "exchange must not import from kalshi-trader");
    // Strip line + block comments so prose mentioning placeOrder() isn't miscounted.
    const code = exch.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    assert.ok(!/\bplaceOrder\s*\(/.test(code), "exchange must not call placeOrder(");
  });

  it("exchange module submits POST /portfolio/events/orders with the fixed scalper semantics", () => {
    assert.match(exch, /\/portfolio\/events\/orders/);
    assert.match(exch, /action:\s*"buy"/);
    assert.match(exch, /side === "yes" \? "bid" : "ask"/);
    assert.match(exch, /time_in_force:\s*"immediate_or_cancel"/);
    assert.match(exch, /self_trade_prevention_type:\s*"taker_at_cross"/);
    // Strict parse of the raw response after HTTP success.
    assert.match(exch, /parseScalpOrderResponse\(raw, count\)/);
  });

  it("exchange module throws on auth absence and non-2xx / invalid JSON / transport failure", () => {
    assert.match(exch, /KALSHI_API_KEY_ID \/ KALSHI_PRIVATE_KEY not configured/);
    assert.match(exch, /if \(!res\.ok\)[\s\S]*?throw new Error/);
    assert.match(exch, /invalid JSON response/);
    assert.match(exch, /transport error/);
  });

  it("thrown strict submit is handled as UNKNOWN (retain budget, incident, breaker)", () => {
    // The catch around placeScalpOrderStrict routes to _handleUnknownExposure.
    const submitCall = idx("await runtime.placeScalpOrderStrict(");
    const submitCatch = svc.indexOf("scalp_submit_threw", submitCall);
    assert.ok(submitCall >= 0 && submitCatch > submitCall, "submit catch must handle throw");
    const unknownHandler = svc.indexOf("_handleUnknownExposure(", submitCall);
    assert.ok(unknownHandler > submitCall && unknownHandler < svc.indexOf("throw new OrderIntentExistsError", submitCatch) + 200);
  });

  it("builds the pinned snapshot and reserves snapshot.budgetDollars", () => {
    assert.ok(idx("buildExecutionRiskSnapshot(") >= 0);
    // claim reserves the snapshot budget + snapshot caps
    assert.match(svc, /claimReservationAndCap\([\s\S]*budget,[\s\S]*snapshot\.dailyCapDollars,\s*snapshot\.openCapDollars/);
    assert.match(svc, /const budget = snapshot\.budgetDollars/);
  });

  it("preflight warms readiness without reserving budget or creating orders", () => {
    const start = idx("async function _runPreflight(");
    const end = svc.indexOf("function _maybeStartPreflight", start);
    assert.ok(start >= 0 && end > start);
    const preflight = svc.slice(start, end);
    assert.match(preflight, /getScalpCommittedTotals\(/);
    assert.match(preflight, /fetchKalshiTarget\(/);
    assert.match(preflight, /getBalance\(\)/);
    assert.match(preflight, /checkFreefallGuard\(/);
    assert.ok(!/claimReservationAndCap\(/.test(preflight), "preflight must not claim a reservation");
    assert.ok(!/insertScalpOrderIntent\(/.test(preflight), "preflight must not create an order intent");
    assert.ok(!/placeScalpOrderStrict\(/.test(preflight), "preflight must not submit an order");
  });

  it("uses a 250ms scan with bounded concurrent candidate evaluation", () => {
    assert.match(svc, /setInterval\([\s\S]*?SCALP_SCAN_INTERVAL_MS\)/);
    assert.match(
      svc,
      /_runWithConcurrency\(candidates,\s*SCALP_MAX_CONCURRENT_CANDIDATES/,
    );
  });

  it("deduplicates and bounds Freefall sample fetches with an authoritative reserved lane", () => {
    assert.match(svc, /const _priceSampleJobs = new Map/);
    assert.match(
      svc,
      /while \(_activePriceSampleFetches < SCALP_MAX_CONCURRENT_CANDIDATES\)/,
    );
    assert.match(svc, /selectNextScalpSamplePriority\(/);
    assert.match(svc, /SCALP_MAX_CONCURRENT_BACKGROUND_SAMPLES/);
    assert.match(svc, /priority === "authoritative"/);
    assert.match(svc, /const existing = _priceSampleJobs\.get\(key\)/);
    assert.match(svc, /existing\.priority = "authoritative"/);
  });

  it("passes the snapshot into _executeScalpAttempt", () => {
    assert.match(
      svc,
      /_executeScalpAttempt\([\s\S]*?claim\.reservationId,[\s\S]*?candidate,[\s\S]*?windowKey,[\s\S]*?mode,[\s\S]*?snapshot,[\s\S]*?claim\.submittedOrders,[\s\S]*?key/,
    );
  });

  it("compareRiskSnapshot runs before any order intent and before submit", () => {
    const cmp = idx("compareRiskSnapshot(");
    const intent = idx("runtime.insertScalpOrderIntent(orderRecord)");
    const place = idx("await runtime.placeScalpOrderStrict(");
    assert.ok(cmp >= 0 && intent >= 0 && place >= 0);
    assert.ok(cmp < intent, "compareRiskSnapshot must precede order intent");
    assert.ok(cmp < place, "compareRiskSnapshot must precede submit");
  });

  it("FINAL freefall guard runs before order intent and before submit", () => {
    const finalFf = idx("FINAL FREEFALL GUARD");
    const intent = idx("runtime.insertScalpOrderIntent(orderRecord)");
    const place = idx("await runtime.placeScalpOrderStrict(");
    assert.ok(finalFf >= 0, "final freefall guard block must exist");
    assert.ok(finalFf < intent, "final freefall guard must precede order intent");
    assert.ok(finalFf < place, "final freefall guard must precede submit");
    // It must use the pinned snapshot freefall config.
    assert.match(
      svc,
      /lookbackMs: snapshot\.freefallLookbackSeconds \* 1000,[\s\S]*?thresholdPct: snapshot\.freefallThresholdPct/,
    );
  });

  it("FINAL target proximity guard uses fresh inputs before order intent and submit", () => {
    const finalProximity = idx("FINAL TARGET PROXIMITY GUARD");
    const intent = idx("runtime.insertScalpOrderIntent(orderRecord)");
    const place = idx("await runtime.placeScalpOrderStrict(");
    assert.ok(finalProximity >= 0, "final target proximity guard block must exist");
    assert.ok(finalProximity < intent, "target proximity guard must precede order intent");
    assert.ok(finalProximity < place, "target proximity guard must precede submit");
    assert.match(svc, /identityResult\.target/);
    assert.match(svc, /snapshot\.targetProximityThresholdPct/);
    assert.match(svc, /snapshot\.freefallGuardEnabled \|\| snapshot\.targetProximityGuardEnabled/);
  });

  it("order sizing goes through sizeOrderWithinReservedBudget (reserved amount)", () => {
    const sized = idx("sizeOrderWithinReservedBudget(reservedBudget, winningAsk, snapshot.bandMax)");
    const place = idx("await runtime.placeScalpOrderStrict(");
    assert.ok(sized >= 0, "sizing must use sizeOrderWithinReservedBudget with reservedBudget");
    assert.ok(sized < place, "sizing must precede submit");
    // reservedBudget is snapshot.budgetDollars
    assert.match(svc, /const reservedBudget = snapshot\.budgetDollars/);
  });

  it("uses the pinned band ceiling for IOC limit while retaining the authoritative quote", () => {
    assert.match(svc, /const limitPrice = computeLimitPrice\(effectiveSide, snapshot\.bandMax\)/);
    assert.match(
      svc,
      /const entryYesPrice = effectiveSide === "yes" \? winningAsk : 1 - winningAsk/,
    );
    assert.match(
      svc,
      /avgFillPrice = entryYesPrice/,
      "paper fills should model price improvement at the observed quote",
    );
  });

  it("FINAL balance check uses worst-case maxExposure before order intent/submit", () => {
    const finalBal = idx("FINAL live balance check");
    const intent = idx("runtime.insertScalpOrderIntent(orderRecord)");
    const place = idx("await runtime.placeScalpOrderStrict(");
    assert.ok(finalBal >= 0, "final balance check block must exist");
    assert.ok(finalBal < intent, "final balance check must precede order intent");
    assert.ok(finalBal < place, "final balance check must precede submit");
    assert.match(svc, /availableBalance < maxExposure/);
  });

  it("does not size from a re-resolved params2 budget", () => {
    assert.ok(!/computeContractCount\(params2\.budgetDollars/.test(svc), "must not size from params2 budget");
    assert.ok(!/availableBalance < budget\b/.test(svc) || /reservedBudget/.test(svc), "balance compares against reserved/exposure");
  });

  it("AUTHORITATIVE post-await validation runs AFTER final balance and AFTER final freefall", () => {
    const finalFf = idx("FINAL FREEFALL GUARD");
    const finalBal = idx("FINAL live balance check");
    const authoritative = idx("AUTHORITATIVE FINAL VALIDATION (post-await)");
    assert.ok(authoritative >= 0, "authoritative post-await validation block must exist");
    assert.ok(finalFf >= 0 && finalBal >= 0);
    assert.ok(authoritative > finalFf, "authoritative validation must be AFTER final freefall");
    assert.ok(authoritative > finalBal, "authoritative validation must be AFTER final balance");
    // And it must precede order intent and submit.
    assert.ok(authoritative < idx("runtime.insertScalpOrderIntent(orderRecord)"));
    assert.ok(authoritative < idx("await runtime.placeScalpOrderStrict("));
  });

  it("authoritative validation uses the synchronous helper (no await inside)", () => {
    // The helper is declared synchronous (no async keyword, no await in body).
    const decl = svc.indexOf("function _finalRiskValidationSync(");
    assert.ok(decl >= 0, "sync helper must exist");
    assert.ok(!/async function _finalRiskValidationSync/.test(svc), "helper must NOT be async");
    // Extract the helper body up to _executeScalpAttempt and assert no `await`.
    const bodyEnd = svc.indexOf("async function _executeScalpAttempt", decl);
    const body = svc.slice(decl, bodyEnd);
    assert.ok(!/\bawait\b/.test(body), "sync final-validation helper must contain no await");
  });

  it("LIVE: a second sync validation occurs AFTER intent insert and BEFORE submit", () => {
    const intent = idx("await runtime.insertScalpOrderIntent(orderRecord)");
    const place = idx("const result = await runtime.placeScalpOrderStrict(");
    assert.ok(intent >= 0 && place >= 0);
    // Find the sync-validation call that sits between intent and submit.
    const between = svc.slice(intent, place);
    const checkPos = between.indexOf("runtime.finalRiskValidationSync(");
    assert.ok(checkPos >= 0, "a sync final validation must occur between intent and submit");
  });

  it("LIVE: NO await between the successful post-intent check and the submit call", () => {
    // From the post-intent sync check to the submit call, the only await
    // must be inside the failure branch (abortIntentAndReleaseReservation),
    // which returns. On the success path there is no await before submit.
    const checkCall = svc.indexOf(
      "const finalReasonLive = runtime.finalRiskValidationSync(snapshot, windowKey, symbol, ticker);",
    );
    const place = svc.indexOf("const result = await runtime.placeScalpOrderStrict(");
    assert.ok(checkCall >= 0 && place >= 0 && checkCall < place);
    // Strip line comments so prose (e.g. "no await occurs") is not miscounted.
    const segment = svc.slice(checkCall, place).replace(/\/\/[^\n]*/g, "");
    // The only awaited call in real code here is the abort inside the `if`
    // failure branch; assert it is the sole await and is followed by `return`.
    const awaits = segment.match(/\bawait\b/g) ?? [];
    assert.equal(awaits.length, 1, "exactly one await (the failure-branch abort) may appear before placeOrder");
    assert.ok(
      /await abortIntentAndReleaseReservation\(\{[\s\S]*?\}\);\s*return;/.test(segment),
      "the single await must be the failure-branch abort that returns",
    );
  });

  it("LIVE: post-intent failure aborts intent + releases (no exchange call), resolved not unknown", () => {
    assert.match(svc, /abortIntentAndReleaseReservation\(\{[\s\S]*?reason: `aborted_before_submit:/);
    // abort marks skipped/release; it is NOT _handleUnknownExposure.
    const abortIdx = svc.indexOf("abortIntentAndReleaseReservation({");
    const between = svc.slice(abortIdx, abortIdx + 400);
    assert.ok(!/\_handleUnknownExposure/.test(between), "abort path must not mark unknown");
  });

  it("PAPER: post-await final validation runs before simulating the fill", () => {
    const paperCheck = svc.indexOf(
      "const finalReasonPaper = runtime.finalRiskValidationSync(snapshot, windowKey, symbol, ticker);",
    );
    const simulate = svc.indexOf("PAPER order simulated");
    assert.ok(paperCheck >= 0 && simulate >= 0);
    assert.ok(paperCheck < simulate, "paper validation must precede simulated fill");
  });

  it("abortIntentAndReleaseReservation exists in the DB layer (atomic)", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const db = readFileSync(join(here, "kalshi-scalper-db.ts"), "utf8");
    assert.match(db, /export async function abortIntentAndReleaseReservation/);
    // Atomic: BEGIN + advisory lock + COMMIT.
    const fnIdx = db.indexOf("export async function abortIntentAndReleaseReservation");
    const fnBody = db.slice(fnIdx, fnIdx + 1400);
    assert.match(fnBody, /BEGIN/);
    assert.match(fnBody, /pg_advisory_xact_lock/);
    assert.match(fnBody, /reserved_budget = 0/);
    assert.match(fnBody, /COMMIT/);
  });

  // ── Freefall fail-closed wiring ────────────────────────────────────────────

  it("FINAL freefall guard requires an authoritative fresh sample (no silent catch)", () => {
    const finalFf = idx("FINAL FREEFALL GUARD");
    const place = idx("await runtime.placeScalpOrderStrict(");
    const intent = idx("runtime.insertScalpOrderIntent(orderRecord)");
    assert.ok(finalFf >= 0 && place >= 0 && intent >= 0);
    // The authoritative fresh sample is awaited in the concurrent readiness
    // batch, then the shared production decision receives that exact result.
    const executeStart = idx("async function _executeScalpAttempt");
    const parallelBoundary = svc.slice(executeStart, finalFf);
    assert.match(parallelBoundary, /await Promise\.all\(\[[\s\S]*?runtime\.collectPriceSample\(/);
    const block = svc.slice(finalFf, idx("Size the order STRICTLY"));
    assert.match(block, /evaluateFreefallPreSubmitGuard\(\{[\s\S]*?freshSampleSucceeded: freshSampleResult/);
    // Must NOT swallow the final fetch with a silent .catch.
    assert.ok(!/runtime\.collectPriceSample\([^)]*\)\.catch\(/.test(parallelBoundary), "final sample must not be best-effort .catch");
    // Fetch failure → unavailable skip before any intent/submit.
    assert.match(block, /if \(!freefallDecision\.allowed\)/);
    assert.ok(finalFf < intent && finalFf < place);
  });

  it("FINAL freefall skips on unavailable OR blocked (fail-closed) before intent/placeOrder", () => {
    const block = svc.slice(idx("FINAL FREEFALL GUARD"), idx("Size the order STRICTLY"));
    // Shared policy only allows fresh, evaluable, non-adverse inputs.
    assert.match(block, /if \(!freefallDecision\.allowed\)/);
    // On the negative path it updates the reservation to skipped and returns.
    assert.match(block, /updateReservationStatus\([\s\S]*?"skipped"[\s\S]*?\);\s*\n\s*return;/);
  });

  it("quote, identity, Freefall sample, and balance are fetched concurrently", () => {
    const executeStart = idx("async function _executeScalpAttempt");
    const finalFf = idx("FINAL FREEFALL GUARD");
    const boundary = svc.slice(executeStart, finalFf);
    assert.match(boundary, /await Promise\.all\(\[/);
    assert.match(boundary, /fetchKalshiTarget\(/);
    assert.match(boundary, /fetchOrderbookPrices\(/);
    assert.match(boundary, /runtime\.collectPriceSample\(/);
    assert.match(boundary, /getBalance\(\)/);
  });

  it("confirmed zero fills schedule a bounded retry but confirmed fills terminate", () => {
    assert.match(
      svc,
      /_rememberReservationOutcome\([\s\S]*?"zero_fill"[\s\S]*?priorSubmittedOrders \+ 1/,
    );
    assert.match(svc, /_terminalAttemptKeys\.add\(attemptKey\)/);
  });

  it("DB re-claim path locks the durable row and counts zero-fill submissions", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const db = readFileSync(join(here, "kalshi-scalper-db.ts"), "utf8");
    const claimStart = db.indexOf("export async function claimReservationAndCap");
    const claimEnd = db.indexOf("export async function updateReservationStatus", claimStart);
    const claim = db.slice(claimStart, claimEnd);
    assert.match(claim, /FOR UPDATE/);
    assert.match(claim, /evaluateScalpReservationRetry\(/);
    assert.match(claim, /status = 'zero_fill'/);
    assert.match(claim, /SET status = 'claimed'/);
    assert.match(claim, /\[blockedReason, JSON\.stringify\(capEvidence\), reservationId\]/);
  });

  it("status exposes retry readiness and cooldown for every policy-retryable outcome", () => {
    const start = idx("recentAttempts: recentAttempts.map");
    const end = svc.indexOf("incidents,", start);
    const status = svc.slice(start, end);
    assert.match(status, /evaluateScalpReservationRetry\(/);
    assert.match(status, /retryEligible: !retry\.terminal/);
    assert.match(status, /retryAfterMs: retry\.retryAfterMs/);
  });

  it("_collectPriceSample returns a boolean success signal (not void)", () => {
    assert.match(svc, /function _collectPriceSample\([\s\S]*?\): Promise<boolean>/);
    // The shared queue resolves true on success and false on failure/unusable.
    const fnIdx = svc.indexOf("function _drainPriceSampleQueue");
    const body = svc.slice(fnIdx, fnIdx + 1_500);
    assert.match(body, /return true;/);
    assert.match(body, /return false;/);
  });

  it("status builder treats unavailable freefall as blocked, not clear", () => {
    assert.match(svc, /freefallBlocked = ff\.blocked \|\| !ff\.evaluable/);
  });

  // ── Route wiring: strict parse + pass parsed value (never raw body) ─────────

  it("POST /config parses with parseScalpConfigPatch and passes parsed.value, not raw body", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const route = readFileSync(join(here, "../routes/kalshi-scalper.ts"), "utf8");
    // Uses the strict parser on req.body.
    assert.match(route, /parseScalpConfigPatch\(req\.body\)/);
    // Passes ONLY the parsed value to the service.
    assert.match(route, /applyScalpConfigUpdate\(parsed\.value\)/);
    // Must NOT pass raw req.body (or a cast of it) into the service.
    assert.ok(!/applyScalpConfigUpdate\(body/.test(route), "must not pass raw body");
    assert.ok(!/applyScalpConfigUpdate\(req\.body/.test(route), "must not pass raw req.body");
    // The old coercing validator is no longer used by the route.
    assert.ok(!/validateScalpConfigPartial/.test(route), "route must not use validate-only helper");
    // On parse failure it returns 400 before touching the service.
    assert.match(route, /if \(!parsed\.ok\)[\s\S]*?res\.status\(400\)/);
  });

  it("service update merge is typed (ScalpConfigPatch) and never touches breaker", () => {
    assert.match(svc, /export async function updateScalpConfig\(patch: ScalpConfigPatch\)/);
    // Breaker fields preserved from existing config, not from patch.
    assert.match(svc, /circuitBreaker: _config\.circuitBreaker/);
    assert.match(svc, /circuitBreakerReason: _config\.circuitBreakerReason/);
  });
});
