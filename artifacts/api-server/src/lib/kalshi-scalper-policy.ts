// ---------------------------------------------------------------------------
// kalshi-scalper-policy.ts — Pure, testable policy functions for the scalper.
// No I/O, no imports from regular bot state. All functions are exported for
// unit testing via node:test.
//
// CANONICAL PRICE MODEL
// ─────────────────────
// yesAsk = cost to buy one YES contract (fraction 0-1).
// noAsk  = cost to buy one NO  contract (fraction 0-1).
// noAsk is derived from the orderbook as: noAsk = 1 - yesBid.
//
// Band selection: check each ask DIRECTLY against [bandMin, bandMax].
//   YES ask in [bandMin, bandMax]  → buy YES, winningContractCost = yesAsk
//   NO  ask in [bandMin, bandMax]  → buy NO,  winningContractCost = noAsk
//
// At placeOrder boundary ONLY:
//   YES: limitPrice (YES-side) = winningAsk  (= yesAsk)
//   NO:  limitPrice (YES-side) = 1 - noAsk   (= yesBid, the NO cost complement)
//
// avgFillPrice from placeOrder is always YES-side fraction.
//   YES winning contract cost at fill = avgFillPrice
//   NO  winning contract cost at fill = 1 - avgFillPrice
//
// P&L (live):
//   YES win:  +(1 - avgFillPrice) * filledCount
//   YES loss: -avgFillPrice * filledCount
//   NO  win:  +avgFillPrice * filledCount
//   NO  loss: -(1 - avgFillPrice) * filledCount
//
// P&L (paper): identical economics to live (no arbitrary discount).
// ---------------------------------------------------------------------------

import type { ScalpConfig, EffectiveScalpParams, ValidatedQuote } from "./kalshi-scalper-types.ts";

// ---------------------------------------------------------------------------
// Effective params resolution
// ---------------------------------------------------------------------------

export function resolveEffectiveParams(
  config: ScalpConfig,
  symbol: string,
  ticker: string,
): EffectiveScalpParams {
  const sym = symbol.toUpperCase();
  const override = config.perMarketOverrides.find(
    (o) => o.symbol.toUpperCase() === sym,
  );
  return {
    symbol: sym,
    ticker,
    paused: override?.paused ?? false,
    bandMin: override?.minBand ?? config.globalBandMin,
    bandMax: override?.maxBand ?? config.globalBandMax,
    finalWindowSeconds: override?.windowSeconds ?? config.finalWindowSeconds,
    budgetDollars: override?.budgetDollars ?? config.budgetDollars,
  };
}

// ---------------------------------------------------------------------------
// Validated quote extraction
// ---------------------------------------------------------------------------

/**
 * Validate an orderbook response for use as a scalper quote.
 * Requires a genuine two-sided book: finite yesBid AND yesAsk with 0 < bid < ask < 1.
 * Returns null when the quote is not usable (empty, one-sided, or inverted).
 */
export function validateOrderbookQuote(ob: {
  yesAsk: number | null;
  yesBid: number | null;
}, ticker: string, closeTime: string): ValidatedQuote | null {
  const { yesAsk, yesBid } = ob;
  if (yesAsk == null || yesBid == null) return null;
  if (!Number.isFinite(yesAsk) || !Number.isFinite(yesBid)) return null;
  if (yesBid <= 0 || yesAsk >= 1) return null;
  if (yesBid >= yesAsk) return null; // inverted or crossed book
  // noAsk = 1 - yesBid: what it costs to buy NO
  const noAsk = 1 - yesBid;
  return { ticker, yesAsk, yesBid, noAsk, closeTime };
}

// ---------------------------------------------------------------------------
// Band / side selection
// ---------------------------------------------------------------------------

/**
 * Determine which side (yes/no) to buy, or null if neither ask is in band.
 *
 * CANONICAL MODEL: yesAsk and noAsk are each the direct cost of buying
 * that contract. We check each ask DIRECTLY against [bandMin, bandMax].
 *
 *   yesAsk in [bandMin, bandMax] → buy YES
 *   noAsk  in [bandMin, bandMax] → buy NO  (only checked if YES doesn't match)
 *
 * Returns { side, winningAsk } where winningAsk is the direct contract cost.
 * Never select both sides.
 */
export function selectScalpSide(
  yesAsk: number | null,
  noAsk: number | null,
  bandMin: number,
  bandMax: number,
): { side: "yes" | "no"; winningAsk: number } | null {
  // YES side: check yesAsk directly
  if (yesAsk != null && Number.isFinite(yesAsk) && yesAsk >= bandMin && yesAsk <= bandMax) {
    return { side: "yes", winningAsk: yesAsk };
  }
  // NO side: check noAsk directly
  if (noAsk != null && Number.isFinite(noAsk) && noAsk >= bandMin && noAsk <= bandMax) {
    return { side: "no", winningAsk: noAsk };
  }
  return null;
}

/**
 * Compute the YES-side limitPrice to pass to placeOrder for a given side and winningAsk.
 *   YES: limitPrice = winningAsk (already YES-side)
 *   NO:  limitPrice = 1 - winningAsk  (complement: noAsk = 1 - yesBid → yesBid = 1 - noAsk)
 */
export function computeLimitPrice(side: "yes" | "no", winningAsk: number): number {
  // Round to cent precision (Kalshi only accepts prices at 1-cent resolution).
  // Use Math.round to avoid floating-point accumulation errors (e.g. 1-0.93 ≈ 0.07000000000000006).
  // YES: floor (never pay more than the ask)
  // NO:  round (complement of winningAsk; tiny fp errors resolved by rounding)
  if (side === "yes") {
    return Math.max(0.01, Math.min(0.99, Math.floor(winningAsk * 100) / 100));
  } else {
    const yesSide = 1 - winningAsk;
    return Math.max(0.01, Math.min(0.99, Math.round(yesSide * 100) / 100));
  }
}

/**
 * Extract winning-contract cost from a confirmed fill.
 * avgFillPrice is always YES-side from placeOrder.
 *   YES: cost = avgFillPrice
 *   NO:  cost = 1 - avgFillPrice
 */
export function winningCostFromFill(side: "yes" | "no", avgFillPrice: number): number {
  return side === "yes" ? avgFillPrice : 1 - avgFillPrice;
}

// ---------------------------------------------------------------------------
// Window timing gate
// ---------------------------------------------------------------------------

/**
 * Returns true when we are within the final-window period before close.
 * Compares the ticker's market close time against currentWindowKey to ensure
 * it represents the CURRENT 15-min window (not a pre-published adjacent one).
 *
 * @param closeTimeIso     ISO string of the market close time
 * @param nowMs            Current time in ms (injectable for testing)
 * @param finalWindowS     Seconds before close to allow entry
 * @param currentWindowKey The result of currentWindowKey() — "YYYY-MM-DDTHH:mm" format
 */
export function isInFinalWindow(
  closeTimeIso: string,
  nowMs: number,
  finalWindowS: number,
  currentWindowKey?: string,
): boolean {
  const closeMs = new Date(closeTimeIso).getTime();
  if (!Number.isFinite(closeMs)) return false;
  const remainingS = (closeMs - nowMs) / 1000;
  if (remainingS <= 0 || remainingS > finalWindowS) return false;

  // If caller provides the current window key, verify this market closes within
  // the current 15-min window (not an adjacent pre-published market).
  if (currentWindowKey) {
    // Current window opened at currentWindowKey:00Z; closes at +15min
    const windowOpenMs = new Date(currentWindowKey + ":00Z").getTime();
    const windowCloseMs = windowOpenMs + 15 * 60 * 1000;
    // closeTime must be within [windowOpen, windowClose+30s] (30s tolerance for rounding)
    if (closeMs < windowOpenMs || closeMs > windowCloseMs + 30_000) return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Budget / contract count
// ---------------------------------------------------------------------------

/**
 * Compute how many contracts to buy given a budget and winning-contract ask price.
 *
 * CANONICAL: Returns 0 when the budget cannot afford even one contract.
 * Never returns a count that would overspend the budget.
 *   count = floor(budget / winningAsk)
 *   Returns 0 if floor result < 1 (i.e. budget < winningAsk).
 */
export function computeContractCount(
  budgetDollars: number,
  winningAsk: number,
): number {
  if (!Number.isFinite(winningAsk) || winningAsk <= 0 || winningAsk >= 1) return 0;
  if (!Number.isFinite(budgetDollars) || budgetDollars <= 0) return 0;
  const count = Math.floor(budgetDollars / winningAsk);
  return count >= 1 ? count : 0;
}

// ---------------------------------------------------------------------------
// Freefall Guard
// ---------------------------------------------------------------------------

export interface FreefallSample {
  price: number;
  at: number; // ms timestamp
}

export interface FreefallGuardResult {
  /**
   * True only when the guard could be evaluated with reliable, timely data.
   * When false, the caller MUST fail closed (skip) if the guard is enabled —
   * an unevaluable guard is NOT a "clear" signal.
   */
  evaluable: boolean;
  /** True when an adverse move meets/exceeds the threshold (only meaningful when evaluable). */
  blocked: boolean;
  /**
   * Machine reason. When !evaluable this is an unavailability reason
   * (e.g. "freefall_unavailable_no_samples"). When blocked it names the adverse
   * direction. Null only when evaluable && !blocked (genuine clear).
   */
  reason: string | null;
  /** Magnitude of adverse move as a percentage over the lookback window. */
  adverseMovePct: number;
  samplesUsed: number;
}

// Freshness/coverage constants tuned for ~1s polling.
//
// FREEFALL_MAX_SAMPLE_AGE_MS: newest sample must be no older than this or the
//   guard cannot see the "now" price. 5s tolerates a couple of missed polls.
// FREEFALL_MIN_COVERAGE_FRAC: the observed span (newest-oldest) must cover at
//   least this fraction of the configured lookback so a brand-new symbol cannot
//   trade after only 1-2 seconds of data. 0.8 = "substantial/full coverage".
// FREEFALL_COVERAGE_TOLERANCE_MS: small absolute slack added to the coverage
//   requirement to account for polling jitter around the window edge.
export const FREEFALL_MAX_SAMPLE_AGE_MS = 5_000;
export const FREEFALL_MIN_COVERAGE_FRAC = 0.8;
export const FREEFALL_COVERAGE_TOLERANCE_MS = 1_500;

/**
 * Freefall Guard — checks underlying price momentum.
 * Scalper-owned samples only; never shares with regular bot.
 *
 * FAIL-CLOSED: returns evaluable=false (NOT a clear) whenever the data is not
 * reliable enough to trust:
 *   - fewer than 2 valid finite samples inside the lookback window
 *   - the newest in-window sample is stale (older than FREEFALL_MAX_SAMPLE_AGE_MS)
 *   - the samples do not cover enough of the configured lookback window
 *     (guards against startup / newly-seen symbols trading on 1-2s of data)
 *
 * When evaluable, blocks:
 *   YES entries during sharply adverse FALLING movement (falling → YES contract
 *       is moving toward losing territory).
 *   NO  entries during sharply adverse RISING movement  (rising → NO contract
 *       is moving toward losing territory).
 *
 * @param samples       Price samples (oldest first)
 * @param side          Side we intend to buy
 * @param nowMs         Current time in ms
 * @param lookbackMs    Window to look back over
 * @param thresholdPct  % adverse move magnitude that triggers block
 */
export function checkFreefallGuard(
  samples: FreefallSample[],
  side: "yes" | "no",
  nowMs: number,
  lookbackMs: number,
  thresholdPct: number,
): FreefallGuardResult {
  const unavailable = (reason: string, samplesUsed: number): FreefallGuardResult => ({
    evaluable: false,
    blocked: false,
    reason,
    adverseMovePct: 0,
    samplesUsed,
  });

  const cutoff = nowMs - lookbackMs;
  // Only VALID (finite, positive price; sane timestamp within window) samples.
  const relevant = samples.filter(
    (s) =>
      s != null &&
      Number.isFinite(s.price) &&
      s.price > 0 &&
      Number.isFinite(s.at) &&
      s.at >= cutoff &&
      s.at <= nowMs,
  );

  // (1) Need at least 2 valid samples to compute a delta at all.
  if (relevant.length < 2) {
    return unavailable("freefall_unavailable_no_samples", relevant.length);
  }

  const oldest = relevant[0];
  const newest = relevant[relevant.length - 1];

  // (2) Newest sample must be fresh; a stale latest price means we are blind
  // to "now" and must not treat the window as clear.
  const newestAge = nowMs - newest.at;
  if (newestAge > FREEFALL_MAX_SAMPLE_AGE_MS) {
    return unavailable("freefall_unavailable_stale", relevant.length);
  }

  // (3) Require substantial coverage of the configured lookback. Without this a
  // symbol seen 2s ago could trade despite a 30s configured lookback.
  const observedSpanMs = newest.at - oldest.at;
  const requiredSpanMs = Math.max(
    0,
    lookbackMs * FREEFALL_MIN_COVERAGE_FRAC - FREEFALL_COVERAGE_TOLERANCE_MS,
  );
  if (observedSpanMs < requiredSpanMs) {
    return unavailable("freefall_unavailable_coverage", relevant.length);
  }

  const priceChangePct = ((newest.price - oldest.price) / oldest.price) * 100;

  // Adverse move magnitude (positive = adverse movement for this side):
  //   YES: falling is adverse → priceChangePct < 0 → magnitude = -priceChangePct
  //   NO:  rising  is adverse → priceChangePct > 0 → magnitude =  priceChangePct
  const adverseMovePct = side === "yes" ? -priceChangePct : priceChangePct;
  const blocked = adverseMovePct >= thresholdPct;

  return {
    evaluable: true,
    blocked,
    reason: blocked
      ? (side === "yes" ? "freefall_adverse_falling" : "freefall_adverse_rising")
      : null,
    adverseMovePct,
    samplesUsed: relevant.length,
  };
}

// ---------------------------------------------------------------------------
// Cap checks
// ---------------------------------------------------------------------------

export interface CapCheckResult {
  allowed: boolean;
  reason: string | null;
}

/**
 * Daily cap check. includesReserved = sum of budget already committed today
 * including outstanding reserved amounts from in-flight attempts.
 */
export function checkDailyCap(
  dailyCapDollars: number | null,
  dailyCommitted: number,
  orderBudget: number,
): CapCheckResult {
  if (dailyCapDollars == null) return { allowed: true, reason: null };
  if (dailyCommitted + orderBudget > dailyCapDollars) {
    return {
      allowed: false,
      reason: `daily_cap_exceeded (committed=${dailyCommitted.toFixed(2)} cap=${dailyCapDollars})`,
    };
  }
  return { allowed: true, reason: null };
}

/**
 * Open (unsettled) cap check. currentOpenCommitted = sum of budget for all
 * unsettled filled orders + reserved amounts for in-flight attempts.
 */
export function checkOpenCap(
  openCapDollars: number | null,
  currentOpenCommitted: number,
  orderBudget: number,
): CapCheckResult {
  if (openCapDollars == null) return { allowed: true, reason: null };
  if (currentOpenCommitted + orderBudget > openCapDollars) {
    return {
      allowed: false,
      reason: `open_cap_exceeded (open=${currentOpenCommitted.toFixed(2)} cap=${openCapDollars})`,
    };
  }
  return { allowed: true, reason: null };
}

// ---------------------------------------------------------------------------
// Atomic cap decision (pure mirror of the SQL claim-and-cap logic)
// ---------------------------------------------------------------------------

export interface CapDecision {
  allowed: boolean;
  reason: string | null;
}

/**
 * Pure mirror of the decision made inside claimReservationAndCap's SQL
 * transaction. Kept in one place so the boundary math is obvious and testable.
 *
 * Both totals ALREADY include actual committed spend + outstanding reserved
 * amounts (excluding this attempt, whose row is reserved_budget=0 at decision
 * time). A cap of null means "no limit". The comparison is strict `>` so the
 * total is allowed to reach the cap exactly.
 */
export function evaluateCapDecision(
  requestedBudget: number,
  dailyCommitted: number,
  openCommitted: number,
  dailyCapDollars: number | null,
  openCapDollars: number | null,
): CapDecision {
  if (dailyCapDollars != null && dailyCommitted + requestedBudget > dailyCapDollars) {
    return {
      allowed: false,
      reason: `daily_cap_exceeded (committed=${dailyCommitted.toFixed(2)} cap=${dailyCapDollars})`,
    };
  }
  if (openCapDollars != null && openCommitted + requestedBudget > openCapDollars) {
    return {
      allowed: false,
      reason: `open_cap_exceeded (open=${openCommitted.toFixed(2)} cap=${openCapDollars})`,
    };
  }
  return { allowed: true, reason: null };
}

// ---------------------------------------------------------------------------
// Execution-risk snapshot (pin every attempt to the risk under which its
// reserved budget was granted; fail closed on any mid-flight change)
// ---------------------------------------------------------------------------

/**
 * Immutable snapshot of ALL risk-relevant inputs captured at candidate/claim
 * time, under which claimReservationAndCap reserved snapshot.budgetDollars.
 *
 * Execution MUST size and cap every submission against snapshot.budgetDollars
 * (the durable reserved amount), and MUST re-verify — at the final pre-submit
 * boundary — that none of these fields changed. On ANY change we skip and
 * release; we NEVER atomically resize an in-flight reservation.
 */
export interface ExecutionRiskSnapshot {
  // Identity
  mode: "paper" | "live";
  symbol: string;
  windowKey: string;
  ticker: string;
  closeTime: string;
  // Market risk params (effective, post per-market override resolution)
  bandMin: number;
  bandMax: number;
  finalWindowSeconds: number;
  budgetDollars: number; // the reserved amount — authoritative for sizing
  paused: boolean;
  // Global caps
  dailyCapDollars: number | null;
  openCapDollars: number | null;
  // Freefall guard config
  freefallGuardEnabled: boolean;
  freefallLookbackSeconds: number;
  freefallThresholdPct: number;
  // Enablement
  enabled: boolean;
}

/** Minimal shape of the config fields the snapshot depends on. */
export interface RiskConfigLike {
  enabled: boolean;
  mode: "paper" | "live";
  dailyCapDollars: number | null;
  openCapDollars: number | null;
  freefallGuardEnabled: boolean;
  freefallLookbackSeconds: number;
  freefallThresholdPct: number;
}

/** Minimal shape of the effective-params fields the snapshot depends on. */
export interface RiskParamsLike {
  bandMin: number;
  bandMax: number;
  finalWindowSeconds: number;
  budgetDollars: number;
  paused: boolean;
}

/**
 * Build an immutable execution-risk snapshot from the config + effective params
 * + market identity captured at claim time. The returned object is frozen so it
 * cannot be mutated in flight.
 */
export function buildExecutionRiskSnapshot(
  config: RiskConfigLike,
  params: RiskParamsLike,
  identity: { symbol: string; windowKey: string; ticker: string; closeTime: string },
): ExecutionRiskSnapshot {
  return Object.freeze({
    mode: config.mode,
    symbol: identity.symbol,
    windowKey: identity.windowKey,
    ticker: identity.ticker,
    closeTime: identity.closeTime,
    bandMin: params.bandMin,
    bandMax: params.bandMax,
    finalWindowSeconds: params.finalWindowSeconds,
    budgetDollars: params.budgetDollars,
    paused: params.paused,
    dailyCapDollars: config.dailyCapDollars,
    openCapDollars: config.openCapDollars,
    freefallGuardEnabled: config.freefallGuardEnabled,
    freefallLookbackSeconds: config.freefallLookbackSeconds,
    freefallThresholdPct: config.freefallThresholdPct,
    enabled: config.enabled,
  });
}

export interface RiskSnapshotComparison {
  /** true only if EVERY risk field is unchanged (safe to submit). */
  unchanged: boolean;
  /** List of field names that changed (empty when unchanged). */
  changedFields: string[];
  /** First changed field as a machine reason, or null. */
  reason: string | null;
}

/**
 * Compare a pinned snapshot against the freshest config + effective params at
 * the final pre-submit boundary. Fail-closed: ANY difference (including budget,
 * caps, band, window, freefall settings, paused, enabled, or mode) marks the
 * attempt unsafe. Identity (symbol/window/ticker/closeTime) is checked too.
 *
 * NaN-safe: two NaN values for the same field are treated as equal (both
 * "absent"); a change between NaN and a number counts as changed.
 */
export function compareRiskSnapshot(
  snapshot: ExecutionRiskSnapshot,
  currentConfig: RiskConfigLike,
  currentParams: RiskParamsLike,
  currentIdentity: { symbol: string; windowKey: string; ticker: string; closeTime: string },
): RiskSnapshotComparison {
  const changed: string[] = [];

  const eqNum = (a: number, b: number): boolean =>
    (Number.isNaN(a) && Number.isNaN(b)) || a === b;
  const eqNullNum = (a: number | null, b: number | null): boolean => {
    if (a === null || b === null) return a === b;
    return eqNum(a, b);
  };

  // Enablement / mode
  if (currentConfig.enabled !== snapshot.enabled) changed.push("enabled");
  if (currentConfig.mode !== snapshot.mode) changed.push("mode");

  // Identity
  if (currentIdentity.symbol !== snapshot.symbol) changed.push("symbol");
  if (currentIdentity.windowKey !== snapshot.windowKey) changed.push("windowKey");
  if (currentIdentity.ticker !== snapshot.ticker) changed.push("ticker");
  if (currentIdentity.closeTime !== snapshot.closeTime) changed.push("closeTime");

  // Market risk params
  if (currentParams.paused !== snapshot.paused) changed.push("paused");
  if (!eqNum(currentParams.bandMin, snapshot.bandMin)) changed.push("bandMin");
  if (!eqNum(currentParams.bandMax, snapshot.bandMax)) changed.push("bandMax");
  if (!eqNum(currentParams.finalWindowSeconds, snapshot.finalWindowSeconds)) changed.push("finalWindowSeconds");
  if (!eqNum(currentParams.budgetDollars, snapshot.budgetDollars)) changed.push("budgetDollars");

  // Global caps
  if (!eqNullNum(currentConfig.dailyCapDollars, snapshot.dailyCapDollars)) changed.push("dailyCapDollars");
  if (!eqNullNum(currentConfig.openCapDollars, snapshot.openCapDollars)) changed.push("openCapDollars");

  // Freefall config
  if (currentConfig.freefallGuardEnabled !== snapshot.freefallGuardEnabled) changed.push("freefallGuardEnabled");
  if (!eqNum(currentConfig.freefallLookbackSeconds, snapshot.freefallLookbackSeconds)) changed.push("freefallLookbackSeconds");
  if (!eqNum(currentConfig.freefallThresholdPct, snapshot.freefallThresholdPct)) changed.push("freefallThresholdPct");

  return {
    unchanged: changed.length === 0,
    changedFields: changed,
    reason: changed.length > 0 ? `risk_changed:${changed[0]}` : null,
  };
}

/**
 * Worst-case actual submit exposure for a limit IOC buy: contractCount priced
 * at the capped winning ask. This is the maximum dollars that could be spent if
 * the whole order fills at the limit.
 */
export function maxSubmitExposure(contractCount: number, cappedWinningAsk: number): number {
  if (!Number.isFinite(contractCount) || contractCount <= 0) return 0;
  if (!Number.isFinite(cappedWinningAsk) || cappedWinningAsk <= 0) return 0;
  return contractCount * cappedWinningAsk;
}

export interface SizedOrderResult {
  contractCount: number;
  cappedWinningAsk: number;
  maxExposure: number;
  /** true when a submittable order (>=1 contract) fits within reservedBudget. */
  ok: boolean;
  reason: string | null;
}

/**
 * Size an order strictly within the durable reserved budget.
 *
 * Contract count = floor(reservedBudget / cappedWinningAsk), so the worst-case
 * exposure (count * cappedWinningAsk) is guaranteed <= reservedBudget. Includes
 * an explicit post-condition assertion so sizing can NEVER exceed the reserved
 * amount even under odd rounding.
 */
export function sizeOrderWithinReservedBudget(
  reservedBudget: number,
  winningAsk: number,
  bandMax: number,
): SizedOrderResult {
  const fail = (reason: string): SizedOrderResult => ({
    contractCount: 0, cappedWinningAsk: 0, maxExposure: 0, ok: false, reason,
  });

  if (!Number.isFinite(reservedBudget) || reservedBudget <= 0) return fail("reserved_budget_invalid");
  if (!Number.isFinite(winningAsk) || winningAsk <= 0 || winningAsk >= 1) return fail("winning_ask_invalid");
  if (!Number.isFinite(bandMax) || bandMax <= 0 || bandMax >= 1) return fail("band_max_invalid");

  // Never submit above the configured band maximum.
  const cappedWinningAsk = Math.min(winningAsk, bandMax);

  const contractCount = computeContractCount(reservedBudget, cappedWinningAsk);
  if (contractCount < 1) return fail("contract_count_zero");

  const maxExposure = maxSubmitExposure(contractCount, cappedWinningAsk);

  // Hard post-condition: exposure must not exceed the reserved budget. If it
  // somehow does (impossible with floor division, but assert defensively), fail
  // closed rather than risk overspending the durable reservation.
  if (maxExposure > reservedBudget) {
    return fail("exposure_exceeds_reserved_budget");
  }

  return { contractCount, cappedWinningAsk, maxExposure, ok: true, reason: null };
}

// ---------------------------------------------------------------------------
// placeOrder result classification (pure, fail-closed)
// ---------------------------------------------------------------------------

export type PlaceOrderClassification = "zero_fill" | "confirmed_fill" | "unknown";

export interface PlaceOrderResultInput {
  filledCount: number | null;
  avgFillPrice: number | null;
  // Optional: when supplied, an overfill (filledCount > requestedCount) is
  // impossible and classified "unknown"; requestedCount must be a positive int.
  requestedCount?: number | null;
}

/**
 * Classify the outcome of a broker placeOrder response. Fail-closed by design.
 *
 * Rules (exact):
 *   1. filledCount === 0                       → "zero_fill"   (avg may be null)
 *   2. filledCount  >  0 AND avgFillPrice is a
 *      finite number strictly inside (0, 1)    → "confirmed_fill"
 *   3. filledCount  >  0 AND avgFillPrice is
 *      null / non-finite / <=0 / >=1           → "unknown"     (CONFIRMED EXPOSURE,
 *                                                 indeterminate price)
 *
 * A "confirmed_fill" is the ONLY classification that permits computing P&L and
 * releasing the reservation. "unknown" means contracts may have been bought at
 * an indeterminate price — never zero-fill it and never release the budget.
 *
 * filledCount MUST be a finite nonnegative INTEGER. A negative, non-finite, null,
 * or FRACTIONAL count is impossible from a whole-contract exchange and is
 * classified "unknown". When requestedCount is supplied it must be a positive
 * integer and an overfill (filledCount > requestedCount) is classified "unknown".
 */
export function classifyPlaceOrderResult(
  input: PlaceOrderResultInput,
): PlaceOrderClassification {
  const { filledCount, avgFillPrice, requestedCount } = input;

  // Guard against garbage counts. filledCount must be a finite, NONNEGATIVE
  // INTEGER. Non-integer (fractional) counts are impossible from a whole-contract
  // exchange and are treated as UNKNOWN (never zero-filled, never confirmed).
  if (
    filledCount == null ||
    !Number.isFinite(filledCount) ||
    !Number.isInteger(filledCount) ||
    filledCount < 0
  ) {
    return "unknown";
  }

  // When the caller supplies the requested count, an overfill (filled >
  // requested) is impossible and is treated as UNKNOWN. If requestedCount is
  // supplied it must itself be a positive integer, otherwise we cannot trust
  // the comparison and fail closed.
  if (requestedCount != null) {
    if (
      !Number.isFinite(requestedCount) ||
      !Number.isInteger(requestedCount) ||
      requestedCount <= 0 ||
      filledCount > requestedCount
    ) {
      return "unknown";
    }
  }

  if (filledCount === 0) {
    // Definite zero fill regardless of avgFillPrice.
    return "zero_fill";
  }

  // filledCount > 0 → contracts were bought; price must be trustworthy.
  if (
    avgFillPrice == null ||
    !Number.isFinite(avgFillPrice) ||
    avgFillPrice <= 0 ||
    avgFillPrice >= 1
  ) {
    // Confirmed exposure with an indeterminate/invalid fill price.
    return "unknown";
  }

  return "confirmed_fill";
}

// ---------------------------------------------------------------------------
// Strict raw exchange-response parser (pure, fail-closed)
// ---------------------------------------------------------------------------

/**
 * Discriminated outcome of parsing a RAW Kalshi CreateOrderV2 response body
 * (already known to be an HTTP 2xx JSON value). Fail-closed: NEVER coerces a
 * malformed field to zero; anything untrustworthy resolves to "unknown".
 *
 *   zero_fill      — validated integer fill_count === 0 (definite no fill).
 *   confirmed_fill — validated positive integer fill (<= requested) with a
 *                    finite average_fill_price strictly inside (0, 1).
 *   unknown        — malformed/missing order_id, bad/missing fill_count,
 *                    fractional/negative/overfill count, or positive fill with
 *                    a missing/invalid average price. CONFIRMED-EXPOSURE-SAFE:
 *                    treat as possible exposure, retain budget, incident, breaker.
 */
export type ScalpFillOutcome = "zero_fill" | "confirmed_fill" | "unknown";

export interface ParsedScalpFill {
  outcome: ScalpFillOutcome;
  reason: string;                 // machine-readable reason code
  orderId: string | null;        // non-empty string only when trusted
  filledCount: number | null;    // validated nonnegative integer, else null
  avgFillPrice: number | null;   // validated (0,1) fraction, else null
}

/**
 * Parse a value that Kalshi accepts as a numeric count field. Accepts an actual
 * finite integer number OR a canonical numeric STRING that represents an integer
 * (optionally with trailing ".0"/".00" zeros, since Kalshi uses fixed-point
 * strings). Rejects: null/undefined/empty, whitespace-padded, non-numeric,
 * NaN/Infinity, negative, and any fractional value (e.g. "1.5").
 * Returns a finite nonnegative integer, or null when unparseable/invalid.
 */
function parseFixedPointInteger(v: unknown): number | null {
  if (typeof v === "number") {
    if (!Number.isFinite(v) || !Number.isInteger(v) || v < 0) return null;
    return v;
  }
  if (typeof v === "string") {
    // No leniency: must be a canonical numeric string. Disallow whitespace,
    // signs other than plain digits, exponents, hex, etc.
    const s = v;
    if (s.length === 0) return null;
    // Match: digits, optional fractional part that is all zeros.
    const m = /^(\d+)(?:\.(0+))?$/.exec(s);
    if (!m) return null;
    const n = Number(m[1]);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return null;
    return n;
  }
  return null;
}

/**
 * Parse a value Kalshi accepts as a numeric price field (fixed-point YES-side
 * dollars). Accepts a finite number or a canonical finite numeric string.
 * Rejects null/undefined/empty/non-numeric/NaN/Infinity. Range is NOT enforced
 * here — the caller applies the (0,1) rule. Returns finite number or null.
 */
function parseFixedPointNumber(v: unknown): number | null {
  if (typeof v === "number") {
    return Number.isFinite(v) ? v : null;
  }
  if (typeof v === "string") {
    const s = v;
    if (s.length === 0) return null;
    // Canonical decimal number (optional single leading minus, digits, optional
    // fractional). No whitespace, no exponent, no multiple dots.
    if (!/^-?\d+(?:\.\d+)?$/.test(s)) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Strictly parse a raw Kalshi CreateOrderV2 response body (HTTP already 2xx).
 *
 * @param raw            the parsed JSON body from the exchange
 * @param requestedCount the positive integer contract count we submitted
 *
 * Fail-closed contract:
 *   - top-level must be a plain object
 *   - order_id must be a NON-EMPTY string for any trusted outcome
 *   - fill_count must be PRESENT and a finite nonnegative INTEGER (number or
 *     canonical integer string incl. trailing-zero fixed-point); missing/null/
 *     empty/nonnumeric/NaN/Infinity/negative/fractional → unknown
 *   - filledCount must be <= requestedCount; requestedCount must be a positive int
 *   - validated 0 → zero_fill (avg may be absent/null)
 *   - positive integral fill → average_fill_price must be present, parseable,
 *     finite, and strictly inside (0,1); else unknown
 */
export function parseScalpOrderResponse(
  raw: unknown,
  requestedCount: number,
): ParsedScalpFill {
  const fail = (reason: string): ParsedScalpFill => ({
    outcome: "unknown",
    reason,
    orderId: null,
    filledCount: null,
    avgFillPrice: null,
  });

  // requestedCount must itself be a positive integer to trust any comparison.
  if (
    !Number.isFinite(requestedCount) ||
    !Number.isInteger(requestedCount) ||
    requestedCount <= 0
  ) {
    return fail("bad_requested_count");
  }

  // Top-level object required (reject null, arrays, primitives).
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return fail("non_object_response");
  }
  const obj = raw as Record<string, unknown>;

  // Non-empty order_id required for ANY trusted outcome.
  const rawOrderId = obj["order_id"];
  if (typeof rawOrderId !== "string" || rawOrderId.length === 0) {
    return fail("missing_order_id");
  }
  const orderId = rawOrderId;

  // fill_count must be PRESENT (not missing/null) and strictly parseable.
  const rawFill = obj["fill_count"];
  if (rawFill == null) {
    return fail("missing_fill_count");
  }
  const filledCount = parseFixedPointInteger(rawFill);
  if (filledCount == null) {
    return fail("unparseable_fill_count");
  }

  // Overfill is impossible.
  if (filledCount > requestedCount) {
    return fail("overfill_count");
  }

  // Definite zero fill — avg may be absent/null.
  if (filledCount === 0) {
    return {
      outcome: "zero_fill",
      reason: "zero_fill",
      orderId,
      filledCount: 0,
      avgFillPrice: null,
    };
  }

  // Positive integral fill → average_fill_price MUST be present + valid + (0,1).
  const rawAvg = obj["average_fill_price"];
  if (rawAvg == null) {
    return fail("missing_avg_price");
  }
  const avg = parseFixedPointNumber(rawAvg);
  if (avg == null || avg <= 0 || avg >= 1) {
    return fail("invalid_avg_price");
  }

  return {
    outcome: "confirmed_fill",
    reason: "confirmed_fill",
    orderId,
    filledCount,
    avgFillPrice: avg,
  };
}

// ---------------------------------------------------------------------------
// P&L calculation
// ---------------------------------------------------------------------------

/**
 * Compute P&L for a settled scalp order.
 *
 * CANONICAL: avgFillPrice is always the YES-side fraction from placeOrder.
 *
 * Live AND paper use identical contract economics (no arbitrary paper discount):
 *   YES win:  +(1 - avgFillPrice) * filledCount
 *   YES loss: -avgFillPrice * filledCount
 *   NO  win:  +avgFillPrice * filledCount    (payout = $1 - cost = $1 - (1-avg) = avg)
 *   NO  loss: -(1 - avgFillPrice) * filledCount
 */
export function computeScalpPnl(
  _mode: "paper" | "live",
  side: "yes" | "no",
  filledCount: number,
  avgFillPrice: number,  // YES-side fraction as returned by placeOrder
  settlementResult: "yes" | "no",
): number {
  const won = side === settlementResult;
  if (side === "yes") {
    return won
      ? (1 - avgFillPrice) * filledCount
      : -avgFillPrice * filledCount;
  } else {
    // NO side: avgFillPrice is YES-side. NO cost = 1 - avgFillPrice, payout = avgFillPrice.
    return won
      ? avgFillPrice * filledCount
      : -(1 - avgFillPrice) * filledCount;
  }
}

// ---------------------------------------------------------------------------
// Band integrity check (for circuit breaker)
// ---------------------------------------------------------------------------

/**
 * Returns true if the actual winning-contract fill cost is within the band.
 * Winning-contract cost:
 *   YES: avgFillPrice         (YES-side fraction from exchange)
 *   NO:  1 - avgFillPrice     (NO contract cost = complement of YES-side avg)
 */
export function isFillWithinBand(
  side: "yes" | "no",
  avgFillPrice: number,   // YES-side fraction as returned by placeOrder
  bandMin: number,
  bandMax: number,
): boolean {
  const winningCost = winningCostFromFill(side, avgFillPrice);
  return winningCost >= bandMin && winningCost <= bandMax;
}

// ---------------------------------------------------------------------------
// Config validation (merged effective config)
// ---------------------------------------------------------------------------

export interface ConfigValidationResult {
  valid: boolean;
  errors: string[];
}

const VALID_SYMBOLS = ["BTC","ETH","SOL","XRP","HYPE","BNB","DOGE","NEAR","ZEC","GOLD","SILVER","WTI"];

/**
 * Validate a partial ScalpConfig update.
 * Also validates the effective per-market config after merging:
 *   effective bandMin must be < effective bandMax for each override.
 */
export function validateScalpConfigPartial(
  partial: Record<string, unknown>,
  current?: { globalBandMin: number; globalBandMax: number },
): ConfigValidationResult {
  const errors: string[] = [];
  const c = partial;

  if (c["globalBandMin"] != null) {
    const v = Number(c["globalBandMin"]);
    if (!Number.isFinite(v) || v <= 0 || v >= 1) errors.push("globalBandMin must be in (0, 1)");
  }
  if (c["globalBandMax"] != null) {
    const v = Number(c["globalBandMax"]);
    if (!Number.isFinite(v) || v <= 0 || v >= 1) errors.push("globalBandMax must be in (0, 1)");
  }

  // Check that the effective global band is valid (merging with current if partial)
  const effMin = c["globalBandMin"] != null ? Number(c["globalBandMin"]) : current?.globalBandMin;
  const effMax = c["globalBandMax"] != null ? Number(c["globalBandMax"]) : current?.globalBandMax;
  if (effMin != null && effMax != null && Number.isFinite(effMin) && Number.isFinite(effMax)) {
    if (effMin >= effMax) errors.push("globalBandMin must be less than globalBandMax");
  }

  if (c["finalWindowSeconds"] != null) {
    const v = Number(c["finalWindowSeconds"]);
    if (!Number.isFinite(v) || v < 1 || v > 900) errors.push("finalWindowSeconds must be 1-900");
  }
  if (c["budgetDollars"] != null) {
    const v = Number(c["budgetDollars"]);
    if (!Number.isFinite(v) || v <= 0 || v > 1000) errors.push("budgetDollars must be > 0 and ≤ 1000");
  }
  // Explicit null is allowed (clears the cap)
  if (c["dailyCapDollars"] != null && c["dailyCapDollars"] !== null) {
    const v = Number(c["dailyCapDollars"]);
    if (!Number.isFinite(v) || v <= 0) errors.push("dailyCapDollars must be > 0 when set");
  }
  if (c["openCapDollars"] != null && c["openCapDollars"] !== null) {
    const v = Number(c["openCapDollars"]);
    if (!Number.isFinite(v) || v <= 0) errors.push("openCapDollars must be > 0 when set");
  }
  if (c["mode"] != null && c["mode"] !== "paper" && c["mode"] !== "live") {
    errors.push("mode must be 'paper' or 'live'");
  }
  if (c["freefallLookbackSeconds"] != null) {
    const v = Number(c["freefallLookbackSeconds"]);
    if (!Number.isFinite(v) || v < 1 || v > 600) errors.push("freefallLookbackSeconds must be 1-600");
  }
  if (c["freefallThresholdPct"] != null) {
    const v = Number(c["freefallThresholdPct"]);
    if (!Number.isFinite(v) || v <= 0) errors.push("freefallThresholdPct must be > 0");
  }

  if (c["perMarketOverrides"] != null) {
    if (!Array.isArray(c["perMarketOverrides"])) {
      errors.push("perMarketOverrides must be an array");
    } else {
      const globalMin = effMin ?? 0;
      const globalMax = effMax ?? 1;
      for (const ov of c["perMarketOverrides"] as Record<string, unknown>[]) {
        const sym = String(ov["symbol"] ?? "").toUpperCase();
        if (!VALID_SYMBOLS.includes(sym)) {
          errors.push(`perMarketOverrides: invalid symbol '${ov["symbol"]}'`);
          continue;
        }
        const ovMin = ov["minBand"] != null ? Number(ov["minBand"]) : null;
        const ovMax = ov["maxBand"] != null ? Number(ov["maxBand"]) : null;
        if (ovMin != null) {
          if (!Number.isFinite(ovMin) || ovMin <= 0 || ovMin >= 1)
            errors.push(`perMarketOverrides[${sym}].minBand must be in (0, 1)`);
        }
        if (ovMax != null) {
          if (!Number.isFinite(ovMax) || ovMax <= 0 || ovMax >= 1)
            errors.push(`perMarketOverrides[${sym}].maxBand must be in (0, 1)`);
        }
        // Effective per-market min/max must satisfy min < max
        const effOvMin = ovMin ?? globalMin;
        const effOvMax = ovMax ?? globalMax;
        if (Number.isFinite(effOvMin) && Number.isFinite(effOvMax) && effOvMin >= effOvMax) {
          errors.push(`perMarketOverrides[${sym}]: effective bandMin (${effOvMin}) must be < bandMax (${effOvMax})`);
        }
        if (ov["budgetDollars"] != null) {
          const v = Number(ov["budgetDollars"]);
          if (!Number.isFinite(v) || v <= 0 || v > 1000)
            errors.push(`perMarketOverrides[${sym}].budgetDollars must be > 0 and ≤ 1000`);
        }
        if (ov["windowSeconds"] != null) {
          const v = Number(ov["windowSeconds"]);
          if (!Number.isFinite(v) || v < 1 || v > 900)
            errors.push(`perMarketOverrides[${sym}].windowSeconds must be 1-900`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Strict typed config-patch parsing + normalization (fail-closed)
//
// parseScalpConfigPatch REJECTS rather than coerces. It returns either a fully
// typed, normalized patch (only the fields present in the input) or a list of
// errors. It is the single source of truth for what an operator POST may change.
// ---------------------------------------------------------------------------

/** Operator-settable fields only. Internal breaker fields are NOT allowed. */
export interface ScalpPerMarketOverridePatch {
  symbol: string;
  paused?: boolean;
  minBand?: number | null;
  maxBand?: number | null;
  windowSeconds?: number | null;
  budgetDollars?: number | null;
}

export interface ScalpConfigPatch {
  enabled?: boolean;
  mode?: "paper" | "live";
  globalBandMin?: number;
  globalBandMax?: number;
  finalWindowSeconds?: number;
  budgetDollars?: number;
  dailyCapDollars?: number | null;
  openCapDollars?: number | null;
  freefallGuardEnabled?: boolean;
  freefallLookbackSeconds?: number;
  freefallThresholdPct?: number;
  perMarketOverrides?: ScalpPerMarketOverridePatch[];
}

export type ParseScalpConfigResult =
  | { ok: true; value: ScalpConfigPatch }
  | { ok: false; errors: string[] };

// Allowlist of top-level operator fields. circuitBreaker / circuitBreakerReason
// are DELIBERATELY excluded — the breaker resets only via its dedicated route.
const ALLOWED_TOP_LEVEL_FIELDS = new Set<string>([
  "enabled",
  "mode",
  "globalBandMin",
  "globalBandMax",
  "finalWindowSeconds",
  "budgetDollars",
  "dailyCapDollars",
  "openCapDollars",
  "freefallGuardEnabled",
  "freefallLookbackSeconds",
  "freefallThresholdPct",
  "perMarketOverrides",
]);

const ALLOWED_OVERRIDE_FIELDS = new Set<string>([
  "symbol",
  "paused",
  "minBand",
  "maxBand",
  "windowSeconds",
  "budgetDollars",
]);

/** True only for a real, finite JSON number (rejects strings, NaN, Infinity). */
function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Strictly parse and normalize an operator config patch.
 *
 * Rejects (never coerces):
 *   - unknown top-level keys (incl. circuitBreaker / circuitBreakerReason)
 *   - enabled / freefallGuardEnabled that are not real booleans
 *   - mode that is not exactly "paper" | "live"
 *   - numeric fields that are not finite JSON numbers, or out of range
 *   - nullable caps that are anything other than number | null
 *   - perMarketOverrides that are not a well-formed array of allowlisted objects,
 *     with normalized/supported uppercase symbols, real booleans, and
 *     number|null numeric overrides; unknown keys / duplicate symbols rejected
 *
 * Explicit null is preserved for the nullable fields (caps + override numerics)
 * to keep "clear this value" semantics distinct from "leave unchanged" (absent).
 */
export function parseScalpConfigPatch(input: unknown): ParseScalpConfigResult {
  const errors: string[] = [];
  const out: ScalpConfigPatch = {};

  if (input == null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, errors: ["body must be a JSON object"] };
  }
  const body = input as Record<string, unknown>;

  // Reject unknown / internal top-level keys.
  for (const key of Object.keys(body)) {
    if (!ALLOWED_TOP_LEVEL_FIELDS.has(key)) {
      errors.push(`unknown or forbidden field: '${key}'`);
    }
  }

  const has = (k: string): boolean => Object.prototype.hasOwnProperty.call(body, k);

  // ── Booleans (must be real booleans) ──
  if (has("enabled")) {
    if (typeof body["enabled"] !== "boolean") errors.push("enabled must be a boolean");
    else out.enabled = body["enabled"];
  }
  if (has("freefallGuardEnabled")) {
    if (typeof body["freefallGuardEnabled"] !== "boolean") errors.push("freefallGuardEnabled must be a boolean");
    else out.freefallGuardEnabled = body["freefallGuardEnabled"];
  }

  // ── mode (exact string) ──
  if (has("mode")) {
    if (body["mode"] !== "paper" && body["mode"] !== "live") errors.push("mode must be exactly 'paper' or 'live'");
    else out.mode = body["mode"];
  }

  // ── Numeric fields (real finite numbers, in range) ──
  const numField = (
    key: "globalBandMin" | "globalBandMax" | "finalWindowSeconds" | "budgetDollars" | "freefallLookbackSeconds" | "freefallThresholdPct",
    ok: (v: number) => boolean,
    msg: string,
  ): void => {
    if (!has(key)) return;
    const v = body[key];
    if (!isFiniteNumber(v) || !ok(v)) { errors.push(msg); return; }
    out[key] = v;
  };
  numField("globalBandMin", (v) => v > 0 && v < 1, "globalBandMin must be a number in (0, 1)");
  numField("globalBandMax", (v) => v > 0 && v < 1, "globalBandMax must be a number in (0, 1)");
  numField("finalWindowSeconds", (v) => v >= 1 && v <= 900, "finalWindowSeconds must be a number 1-900");
  numField("budgetDollars", (v) => v > 0 && v <= 1000, "budgetDollars must be a number > 0 and ≤ 1000");
  numField("freefallLookbackSeconds", (v) => v >= 1 && v <= 600, "freefallLookbackSeconds must be a number 1-600");
  numField("freefallThresholdPct", (v) => v > 0, "freefallThresholdPct must be a number > 0");

  // ── Nullable caps (number | null only) ──
  const capField = (key: "dailyCapDollars" | "openCapDollars"): void => {
    if (!has(key)) return;
    const v = body[key];
    if (v === null) { out[key] = null; return; }
    if (!isFiniteNumber(v) || v <= 0) { errors.push(`${key} must be a number > 0 or null`); return; }
    out[key] = v;
  };
  capField("dailyCapDollars");
  capField("openCapDollars");

  // Cross-field: effective band min < max (only when both provided together).
  if (out.globalBandMin != null && out.globalBandMax != null && out.globalBandMin >= out.globalBandMax) {
    errors.push("globalBandMin must be less than globalBandMax");
  }

  // ── perMarketOverrides (strict array of allowlisted objects) ──
  if (has("perMarketOverrides")) {
    const raw = body["perMarketOverrides"];
    if (!Array.isArray(raw)) {
      errors.push("perMarketOverrides must be an array");
    } else {
      const parsed: ScalpPerMarketOverridePatch[] = [];
      const seen = new Set<string>();
      raw.forEach((entry, i) => {
        if (entry == null || typeof entry !== "object" || Array.isArray(entry)) {
          errors.push(`perMarketOverrides[${i}] must be an object`);
          return;
        }
        const ov = entry as Record<string, unknown>;
        for (const k of Object.keys(ov)) {
          if (!ALLOWED_OVERRIDE_FIELDS.has(k)) errors.push(`perMarketOverrides[${i}]: unknown field '${k}'`);
        }
        // symbol: required, must be an exact supported string, normalized upper.
        if (typeof ov["symbol"] !== "string") {
          errors.push(`perMarketOverrides[${i}].symbol must be a string`);
          return;
        }
        const sym = ov["symbol"].toUpperCase();
        if (!VALID_SYMBOLS.includes(sym)) {
          errors.push(`perMarketOverrides[${i}]: unsupported symbol '${ov["symbol"]}'`);
          return;
        }
        if (seen.has(sym)) {
          errors.push(`perMarketOverrides: duplicate symbol '${sym}'`);
          return;
        }
        seen.add(sym);

        const patch: ScalpPerMarketOverridePatch = { symbol: sym };

        if (Object.prototype.hasOwnProperty.call(ov, "paused")) {
          if (typeof ov["paused"] !== "boolean") errors.push(`perMarketOverrides[${sym}].paused must be a boolean`);
          else patch.paused = ov["paused"];
        }

        const ovNumOrNull = (
          field: "minBand" | "maxBand" | "windowSeconds" | "budgetDollars",
          ok: (v: number) => boolean,
          msg: string,
        ): void => {
          if (!Object.prototype.hasOwnProperty.call(ov, field)) return;
          const v = ov[field];
          if (v === null) { patch[field] = null; return; }
          if (!isFiniteNumber(v) || !ok(v)) { errors.push(msg); return; }
          patch[field] = v;
        };
        ovNumOrNull("minBand", (v) => v > 0 && v < 1, `perMarketOverrides[${sym}].minBand must be a number in (0, 1) or null`);
        ovNumOrNull("maxBand", (v) => v > 0 && v < 1, `perMarketOverrides[${sym}].maxBand must be a number in (0, 1) or null`);
        ovNumOrNull("windowSeconds", (v) => v >= 1 && v <= 900, `perMarketOverrides[${sym}].windowSeconds must be a number 1-900 or null`);
        ovNumOrNull("budgetDollars", (v) => v > 0 && v <= 1000, `perMarketOverrides[${sym}].budgetDollars must be a number > 0 and ≤ 1000 or null`);

        // Effective per-override band min < max when BOTH are concrete numbers.
        if (
          typeof patch.minBand === "number" &&
          typeof patch.maxBand === "number" &&
          patch.minBand >= patch.maxBand
        ) {
          errors.push(`perMarketOverrides[${sym}]: minBand must be < maxBand`);
        }

        parsed.push(patch);
      });
      if (errors.length === 0) out.perMarketOverrides = parsed;
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: out };
}
