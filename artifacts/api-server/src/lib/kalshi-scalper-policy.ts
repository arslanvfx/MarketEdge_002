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
// At placeOrder boundary ONLY, use the configured band ceiling as the worst
// acceptable winning-contract cost. Kalshi may price-improve inside that cap:
//   YES: limitPrice (YES-side) = bandMax
//   NO:  limitPrice (YES-side) = 1 - bandMax
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

import {
  normalizeScalpOpenCapDollars,
  type ScalpConfig,
  type EffectiveScalpParams,
  type ScalpMarketStatus,
  type ScalpTimingPhase,
  type ValidatedQuote,
} from "./kalshi-scalper-types.ts";

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

export type ScalpQuoteRequalification =
  | {
      ok: true;
      quote: ValidatedQuote;
      side: "yes" | "no";
      winningAsk: number;
    }
  | {
      ok: false;
      reason:
        | "final_requote_invalid"
        | "final_requote_outside_band"
        | "side_flipped_final_requote";
      quote: ValidatedQuote | null;
      selectedSide: "yes" | "no" | null;
      winningAsk: number | null;
    };

/**
 * Requalify a late authenticated quote without weakening the pinned execution
 * policy. This pure boundary makes quote churn behavior directly testable.
 */
export function requalifyAuthenticatedScalpQuote(args: {
  orderbook: { yesAsk: number | null; yesBid: number | null };
  ticker: string;
  closeTime: string;
  bandMin: number;
  bandMax: number;
  initialSide: "yes" | "no";
}): ScalpQuoteRequalification {
  const quote = validateOrderbookQuote(args.orderbook, args.ticker, args.closeTime);
  if (!quote) {
    return {
      ok: false,
      reason: "final_requote_invalid",
      quote: null,
      selectedSide: null,
      winningAsk: null,
    };
  }
  const match = selectScalpSide(
    quote.yesAsk,
    quote.noAsk,
    args.bandMin,
    args.bandMax,
  );
  if (!match) {
    return {
      ok: false,
      reason: "final_requote_outside_band",
      quote,
      selectedSide: null,
      winningAsk: null,
    };
  }
  if (match.side !== args.initialSide) {
    return {
      ok: false,
      reason: "side_flipped_final_requote",
      quote,
      selectedSide: match.side,
      winningAsk: match.winningAsk,
    };
  }
  return {
    ok: true,
    quote,
    side: match.side,
    winningAsk: match.winningAsk,
  };
}

/**
 * Compute the marketable YES-side IOC limit from the configured maximum
 * winning-contract cost. Kalshi price-improves fills, so this is a hard
 * worst-acceptable boundary rather than the transient observed quote.
 *
 *   YES: highest acceptable YES cost = maxWinningCost
 *   NO:  lowest acceptable YES price = 1 - maxWinningCost
 */
export function computeLimitPrice(side: "yes" | "no", maxWinningCost: number): number {
  // Quantize the winning cost down to a whole cent so the actual executable cap
  // never exceeds configuration. Deriving the NO complement from integer cents
  // avoids 1 - 0.95 floating-point drift accidentally becoming 0.06.
  const maxWinningCents = Math.max(
    1,
    Math.min(99, Math.floor(maxWinningCost * 100 + 1e-9)),
  );
  const yesSideCents = side === "yes" ? maxWinningCents : 100 - maxWinningCents;
  return yesSideCents / 100;
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
// Timing phase resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the human-visible timing phase for a market candidate. Used by the
 * status API to let the frontend distinguish:
 *   preflight_warmup    — inside the preflight lead period but not yet inside
 *                         the final submission window; never submission-eligible.
 *   waiting_eligibility — close time is unavailable or the preflight lead has
 *                         not started yet.
 *   eligible            — inside the final submission window (>0 s remaining).
 *   closed_expired      — close time has already passed (remainingS <= 0).
 *
 * @param closeTimeIso     ISO string of the market close time (null/empty → preflight_warmup)
 * @param nowMs            Current time in ms
 * @param finalWindowS     Effective final window seconds for this symbol
 * @param preflightLeadS   Preflight lead seconds (SCALP_PREFLIGHT_LEAD_SECONDS)
 */
export function resolveTimingPhase(
  closeTimeIso: string | null | undefined,
  nowMs: number,
  finalWindowS: number,
  preflightLeadS: number,
): ScalpTimingPhase {
  if (!closeTimeIso) return "waiting_eligibility";
  const closeMs = new Date(closeTimeIso).getTime();
  if (!Number.isFinite(closeMs)) return "waiting_eligibility";
  const remainingS = (closeMs - nowMs) / 1000;
  if (remainingS <= 0) return "closed_expired";
  if (remainingS <= finalWindowS) return "eligible";
  if (remainingS <= finalWindowS + preflightLeadS) return "preflight_warmup";
  return "waiting_eligibility";
}

/**
 * Seconds until the eligibility window opens.
 * Returns 0 when already eligible, null when close time is unavailable or expired.
 */
export function secondsUntilEligible(
  closeTimeIso: string | null | undefined,
  nowMs: number,
  finalWindowS: number,
): number | null {
  if (!closeTimeIso) return null;
  const closeMs = new Date(closeTimeIso).getTime();
  if (!Number.isFinite(closeMs)) return null;
  const remainingS = (closeMs - nowMs) / 1000;
  if (remainingS <= 0) return null; // closed/expired
  if (remainingS <= finalWindowS) return 0; // already eligible
  return remainingS - finalWindowS;
}

// ---------------------------------------------------------------------------
// Bounded retry policy
// ---------------------------------------------------------------------------

/** Fast-window cadence and retry limits. These are deliberately not user
 * configurable: they control exchange pressure and duplicate-order safety,
 * rather than trading strategy. */
export const SCALP_SCAN_INTERVAL_MS = 250;
/** Re-arm transient authenticated quote churn on the next 250ms scan pass. */
export const SCALP_AUTH_RETRY_COOLDOWN_MS = 250;
/** Maximum additional authenticated quote requests within one reserved attempt. */
export const SCALP_MAX_AUTHENTICATED_QUOTE_RETRIES = 2;
/** Leave enough time for a retry response and the synchronous safety boundary. */
export const SCALP_AUTHENTICATED_QUOTE_RETRY_MIN_REMAINING_MS = 2_000;
export const SCALP_GUARD_RETRY_COOLDOWN_MS = 1_000;
export const SCALP_BALANCE_RETRY_COOLDOWN_MS = 2_000;
export const SCALP_MAX_SUBMISSIONS_PER_WINDOW = 3;

/** Same-lifecycle resubmission is exclusively for an authoritative zero fill. */
export function shouldRetryConfirmedZeroFillSameLifecycle(
  outcome: PlaceOrderClassification,
  submittedOrders: number,
): boolean {
  return outcome === "zero_fill"
    && Number.isFinite(submittedOrders)
    && submittedOrders >= 1
    && submittedOrders < SCALP_MAX_SUBMISSIONS_PER_WINDOW;
}
/** Begin non-submitting warm-up three minutes before the entry window opens. */
export const SCALP_PREFLIGHT_LEAD_SECONDS = 180;
export const SCALP_PREFLIGHT_REFRESH_MS = 5_000;
export const SCALP_PREFLIGHT_EARLY_REFRESH_MS = 15_000;
export const SCALP_PREFLIGHT_FAST_ZONE_SECONDS = 30;
export const SCALP_MAX_CONCURRENT_CANDIDATES = 3;
/** Keep one of the three ticker lanes free for final authoritative guard work. */
export const SCALP_MAX_CONCURRENT_BACKGROUND_SAMPLES = 2;

/**
 * Allow the execution guard to use recent preflight samples without ever
 * carrying observations across market windows. The guard's own trailing
 * lookback still limits how much history is selected.
 */
export function scalpGuardObservationStartMs(
  windowKey: string,
  closeTime: string,
  finalWindowSeconds: number,
): number {
  const windowOpenMs = Date.parse(`${windowKey}:00.000Z`);
  const closeMs = Date.parse(closeTime);
  const eligibilityStartMs = closeMs - finalWindowSeconds * 1_000;
  const preflightStartMs =
    eligibilityStartMs - SCALP_PREFLIGHT_LEAD_SECONDS * 1_000;
  if (!Number.isFinite(windowOpenMs)) return eligibilityStartMs;
  if (!Number.isFinite(preflightStartMs)) return windowOpenMs;
  return Math.max(windowOpenMs, preflightStartMs);
}

export function scalpPreflightRefreshMs(startsInSeconds: number): number {
  return startsInSeconds <= SCALP_PREFLIGHT_FAST_ZONE_SECONDS
    ? SCALP_PREFLIGHT_REFRESH_MS
    : SCALP_PREFLIGHT_EARLY_REFRESH_MS;
}

export type AuthenticatedQuoteRetryDecision =
  | { retry: true; reason: "transient_invalid_quote" }
  | {
      retry: false;
      reason: "quote_retry_limit_reached" | "deadline_before_quote_retry" | "window_expired_before_quote_retry";
    };

/**
 * Decide whether an invalid/one-sided authenticated quote may be retried
 * synchronously inside the current reserved attempt.
 *
 * This deliberately does not retry a valid quote that moved outside the band:
 * that is a real price decision, not a data-quality failure. Every successful
 * retry still passes the same band and final safety checks at the caller.
 */
export function decideAuthenticatedQuoteRetry(input: {
  quoteReason: "final_requote_invalid" | "final_requote_outside_band" | "side_flipped_final_requote";
  retryCount: number;
  secondsRemaining: number;
  sameWindow: boolean;
}): AuthenticatedQuoteRetryDecision {
  if (!input.sameWindow) {
    return { retry: false, reason: "window_expired_before_quote_retry" };
  }
  if (input.quoteReason !== "final_requote_invalid") {
    return { retry: false, reason: "quote_retry_limit_reached" };
  }
  if (
    !Number.isFinite(input.secondsRemaining)
    || input.secondsRemaining * 1_000 < SCALP_AUTHENTICATED_QUOTE_RETRY_MIN_REMAINING_MS
  ) {
    return { retry: false, reason: "deadline_before_quote_retry" };
  }
  if (
    !Number.isFinite(input.retryCount)
    || input.retryCount >= SCALP_MAX_AUTHENTICATED_QUOTE_RETRIES
  ) {
    return { retry: false, reason: "quote_retry_limit_reached" };
  }
  return { retry: true, reason: "transient_invalid_quote" };
}

export interface ScalpReservationRetryDecision {
  /** True only when the row may be atomically returned to `claimed` now. */
  retryableNow: boolean;
  /** Non-null when the outcome is retryable after this remaining cooldown. */
  retryAfterMs: number | null;
  /** True when this symbol/window must never be retried. */
  terminal: boolean;
  reason: "retry_ready" | "retry_cooldown" | "retry_limit_reached" | "terminal";
}

const QUICK_RETRY_SKIP_REASONS = new Set([
  // Backward-compatible names from the original two-quote path.
  "first_quote_invalid",
  "first_quote_outside_band",
  "side_flipped_first_quote",
  "second_quote_invalid",
  "second_quote_outside_band",
  "side_flipped_second_quote",
  // Current consolidated final-quote path.
  "final_quote_invalid",
  "final_quote_outside_band",
  "side_flipped_final_quote",
  // A final, bounded requalification can see ordinary order-book churn after
  // all safety reads complete. It remains safe to re-arm this symbol/window.
  "final_requote_invalid",
  "final_requote_outside_band",
  "side_flipped_final_requote",
]);

/**
 * Decide whether a durable reservation may be re-claimed.
 *
 * Only outcomes that prove no exposure was created can retry. Unknown,
 * submitting, filled, daily-cap/risk/identity failures, and arbitrary errors
 * are terminal. Open-cap denials may retry because headroom can be held only
 * temporarily by another candidate's pre-submit reservation. A confirmed
 * zero-fill may retry until the bounded submission limit. Freefall and balance
 * failures can retry more slowly, but every retry still has to pass the same
 * authoritative final checks.
 */
export function evaluateScalpReservationRetry(input: {
  status: string;
  reason: string | null | undefined;
  elapsedMs: number;
  submittedOrders: number;
}): ScalpReservationRetryDecision {
  const elapsedMs = Number.isFinite(input.elapsedMs) ? Math.max(0, input.elapsedMs) : 0;
  const submittedOrders = Number.isFinite(input.submittedOrders)
    ? Math.max(0, Math.floor(input.submittedOrders))
    : 0;
  let cooldownMs: number | null = null;

  if (input.status === "zero_fill") {
    if (submittedOrders >= SCALP_MAX_SUBMISSIONS_PER_WINDOW) {
      return {
        retryableNow: false,
        retryAfterMs: null,
        terminal: true,
        reason: "retry_limit_reached",
      };
    }
    cooldownMs = SCALP_AUTH_RETRY_COOLDOWN_MS;
  } else if (input.status === "skipped") {
    const reason = input.reason ?? "";
    if (QUICK_RETRY_SKIP_REASONS.has(reason)) {
      cooldownMs = SCALP_AUTH_RETRY_COOLDOWN_MS;
    } else if (reason.startsWith("open_cap_exceeded")) {
      // Headroom can be temporarily occupied by another candidate's
      // authoritative pre-submit reservation and released moments later.
      // Every retry still re-enters the atomic claim-and-cap transaction.
      cooldownMs = SCALP_AUTH_RETRY_COOLDOWN_MS;
    } else if (
      reason.startsWith("freefall_")
      || reason.startsWith("adverse_excursion_")
      || reason.startsWith("rapid_move_")
      || reason.startsWith("target_proximity_")
    ) {
      cooldownMs = SCALP_GUARD_RETRY_COOLDOWN_MS;
    } else if (
      reason === "insufficient_balance_final" ||
      reason === "balance_check_failed_final"
    ) {
      cooldownMs = SCALP_BALANCE_RETRY_COOLDOWN_MS;
    }
  }

  if (cooldownMs == null) {
    return {
      retryableNow: false,
      retryAfterMs: null,
      terminal: true,
      reason: "terminal",
    };
  }

  const retryAfterMs = Math.max(0, cooldownMs - elapsedMs);
  return retryAfterMs === 0
    ? {
        retryableNow: true,
        retryAfterMs: 0,
        terminal: false,
        reason: "retry_ready",
      }
    : {
        retryableNow: false,
        retryAfterMs,
        terminal: false,
        reason: "retry_cooldown",
      };
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
  /** Execution provenance; absent only in legacy or test fixtures. */
  source?: "authoritative" | "background";
  /** Source oracle publish time for dedicated authoritative monitor samples. */
  oraclePublishedAtMs?: number | null;
  /** Oracle age at collection time, not reevaluated against later guard time. */
  oracleAgeMs?: number | null;
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
  /** Adverse oldest-to-newest move retained from the original guard. */
  endpointAdverseMovePct: number;
  /** Adverse recent-extreme-to-newest move used to catch sharp reversals. */
  reversalAdverseMovePct: number;
  samplesUsed: number;
  requiredSamples: number;
  consecutiveWrongWayMoves: number;
  consecutiveWrongWaySeconds: number;
  requiredConsecutiveMoves: number;
  observedSpanMs: number;
  directionalMovePct: number;
  /** Absolute side-aware displacement required for favorable confirmation. */
  favorableTrendMinimumPct: number;
  /** Number of distinct price updates available to the directional guard. */
  uniqueDirectionalSamples: number;
  /** True when the complete direction window moved away from the target. */
  favorableTrendConfirmed: boolean | null;
  /** True when the enabled complete-window confirmation rejected the entry. */
  favorableTrendBlocked: boolean;
  /** Exact complete-window confirmation failure, or null when clear/disabled. */
  favorableTrendReason: string | null;
  /** Optional target-distance/time projection that may soften only the
   * complete-window net-trend rejection. */
  coordinatedDirectionClearanceApplied: boolean;
  coordinatedDirectionClearanceSafe: boolean | null;
  coordinatedDirectionClearanceReason: string | null;
  adversePacePctPerSecond: number | null;
  projectedAdverseMovePct: number | null;
  projectedDistancePct: number | null;
  projectedPrice: number | null;
  secondsRemaining: number | null;
  /** Whether every selected direction sample stayed on the winning target side. */
  targetSideWindowConfirmed: boolean | null;
  /** First selected sample that violated the complete-window target-side rule. */
  targetSideViolationPrice: number | null;
  targetSideViolationAt: number | null;
  latestPrice: number | null;
  targetPrice: number | null;
  directionalBlocked: boolean;
  wrongTargetSide: boolean;
  rapidMoveBlocked: boolean;
  rapidMovePct: number;
  /** Exact cadence samples used by the enabled direction/rapid checks. */
  evaluatedSamples: FreefallSample[];
  /** Prior wrong-way streaks interrupted by a flat or favorable sample. */
  wrongWayResetCount: number;
  /** Timestamp of the most recent reset sample, when one occurred. */
  lastWrongWayResetAt: number | null;
  /** Independent recent-extreme latch; optional for rolling evidence compatibility. */
  adverseExcursionBlocked?: boolean;
  adverseExcursionPct?: number | null;
  adverseExcursionLookbackSeconds?: number | null;
  adverseExcursionRecoverySeconds?: number | null;
  adverseExcursionRecoverySamples?: number | null;
  adverseExcursionTriggeredAt?: number | null;
}

export interface FreefallPreSubmitDecision {
  /** True only when the enabled guard has fresh, evaluable, non-adverse inputs. */
  allowed: boolean;
  /** Durable machine reason recorded when the attempt is blocked. */
  reason: string | null;
  /** Full guard result when price samples reached the momentum evaluator. */
  guardResult: FreefallGuardResult | null;
  /** Oldest-to-newest coverage of valid in-window samples, for dashboard evidence. */
  sampleCoverageMs: number | null;
}
export const FREEFALL_MAX_SAMPLE_AGE_MS = 2_000;
export const FREEFALL_MIN_SAMPLE_INTERVAL_MS = 700;
export const FREEFALL_MAX_SAMPLE_INTERVAL_MS = 1_800;
export const CONTRARIAN_COMMODITY_MAX_ORACLE_PUBLISH_GAP_MS = 6_000;
export const CONTRARIAN_COMMODITY_MIN_DISTINCT_PUBLISHES = 3;
/**
 * A favorable endpoint move must clear ordinary quote noise. This is separate
 * from the rapid-move threshold: it proves direction rather than limiting
 * speed. 0.00005% is 0.5 ppm: above the incident's +0.00003% endpoint
 * noise, while production replay preserves meaningful low-volatility updates.
 */
export const FAVORABLE_TREND_MIN_MOVE_PCT = 0.00005;

export interface FreefallGuardInput {
  samples: FreefallSample[];
  side: "yes" | "no";
  nowMs: number;
  directionEnabled: boolean;
  /** Exact boundary at which this market became eligible for Scalper execution. */
  eligibilityStartMs: number;
  /** Number of consecutive one-second wrong-way moves required to block. */
  consecutiveSeconds: number;
  /** Require positive net movement for YES and negative net movement for NO. */
  favorableTrendConfirmationEnabled: boolean;
  /** Opt-in coordination: a weak adverse net trend may clear only when the
   * side-aware projected close retains the target-proximity buffer. */
  coordinatedDirectionClearanceEnabled?: boolean;
  /** Active Kalshi target/strike for the reserved market. */
  targetPrice: number;
  targetProximityGuardEnabled?: boolean;
  targetProximityThresholdPct?: number;
  secondsRemaining?: number;
  /** Independent absolute-speed filter. */
  rapidMoveEnabled: boolean;
  rapidMoveLookbackSeconds: number;
  rapidMoveThresholdPct: number;
  adverseExcursionEnabled?: boolean;
  adverseExcursionLookbackSeconds?: number;
  adverseExcursionThresholdPct?: number;
  adverseExcursionRecoverySeconds?: number;
  /** Require distinct fresh oracle updates; used by the Contrarian commodity lane. */
  requireDistinctOraclePublishTimes?: boolean;
  /** Use Pyth publication cadence instead of Coinbase's one-second cadence. */
  authoritativeCommodityCadence?: boolean;
}

type CadencedSamplesResult =
  | { ok: true; samples: FreefallSample[] }
  | { ok: false; reason: string; samplesUsed: number };

/**
 * Select trustworthy real-time movement points walking backwards from the
 * current authoritative price. The selected sequence must span the full
 * configured elapsed duration; extra sub-second candidate fetches can never
 * make the guard ready early.
 */
function selectCadencedSamples(
  relevant: FreefallSample[],
  requiredMoves: number,
): CadencedSamplesResult {
  const requiredSamples = requiredMoves + 1;
  const selected: FreefallSample[] = [];
  let nextNewerAt: number | null = null;

  for (let index = relevant.length - 1; index >= 0; index -= 1) {
    const sample = relevant[index];
    if (nextNewerAt == null || nextNewerAt - sample.at >= FREEFALL_MIN_SAMPLE_INTERVAL_MS) {
      selected.unshift(sample);
      nextNewerAt = sample.at;
      const observedSpanMs =
        selected[selected.length - 1].at - selected[0].at;
      if (
        selected.length >= requiredSamples
        && observedSpanMs >= requiredMoves * 1_000
      ) {
        break;
      }
    }
  }

  if (selected.length < requiredSamples) {
    return {
      ok: false,
      reason: "freefall_unavailable_warming",
      samplesUsed: selected.length,
    };
  }

  for (let index = 1; index < selected.length; index += 1) {
    const gapMs = selected[index].at - selected[index - 1].at;
    if (gapMs > FREEFALL_MAX_SAMPLE_INTERVAL_MS) {
      return {
        ok: false,
        reason: "freefall_unavailable_sample_gap",
        samplesUsed: selected.length,
      };
    }
  }

  const observedSpanMs = selected[selected.length - 1].at - selected[0].at;
  const requiredSpanMs = requiredMoves * 1_000;
  if (observedSpanMs < requiredSpanMs) {
    return {
      ok: false,
      reason: "freefall_unavailable_warming",
      samplesUsed: selected.length,
    };
  }

  return { ok: true, samples: selected };
}

function selectCommodityOracleSamples(
  relevant: FreefallSample[],
  lookbackSeconds: number,
  nowMs: number,
): CadencedSamplesResult {
  const byPublishTime = new Map<number, FreefallSample>();
  for (const sample of relevant) {
    const publishedAt = sample.oraclePublishedAtMs;
    if (
      !Number.isFinite(publishedAt)
      || !Number.isFinite(sample.oracleAgeMs)
      || (sample.oracleAgeMs as number) < 0
      || (sample.oracleAgeMs as number) > 5_000
    ) return { ok: false, reason: "freefall_unavailable_oracle_stale", samplesUsed: 0 };
    // Repeated polling receipts never become extra cadence observations.
    byPublishTime.set(publishedAt as number, sample);
  }
  const receipts = [...byPublishTime.values()].sort(
    (a, b) => a.oraclePublishedAtMs! - b.oraclePublishedAtMs!,
  );
  if (receipts.length < CONTRARIAN_COMMODITY_MIN_DISTINCT_PUBLISHES) {
    return { ok: false, reason: "freefall_unavailable_distinct_publishes", samplesUsed: receipts.length };
  }
  const newest = receipts[receipts.length - 1];
  if (nowMs - newest.oraclePublishedAtMs! > 5_000 || newest.oraclePublishedAtMs! > nowMs + 1_000) {
    return { ok: false, reason: "freefall_unavailable_oracle_stale", samplesUsed: receipts.length };
  }
  const selected: FreefallSample[] = [newest];
  for (let index = receipts.length - 2; index >= 0; index -= 1) {
    const gap = selected[0].oraclePublishedAtMs! - receipts[index].oraclePublishedAtMs!;
    if (gap <= 0 || gap > CONTRARIAN_COMMODITY_MAX_ORACLE_PUBLISH_GAP_MS) {
      return { ok: false, reason: "freefall_unavailable_oracle_gap", samplesUsed: selected.length };
    }
    selected.unshift(receipts[index]);
    if (
      selected.length >= CONTRARIAN_COMMODITY_MIN_DISTINCT_PUBLISHES
      && newest.oraclePublishedAtMs! - selected[0].oraclePublishedAtMs!
        >= lookbackSeconds * 1_000
    ) break;
  }
  if (newest.oraclePublishedAtMs! - selected[0].oraclePublishedAtMs! < lookbackSeconds * 1_000) {
    return { ok: false, reason: "freefall_unavailable_warming", samplesUsed: selected.length };
  }
  const samples = selected.map((sample) => ({
    ...sample,
    // All movement math must use the authoritative publication cadence.
    // Local receipt freshness is enforced separately before this selector.
    at: sample.oraclePublishedAtMs!,
  }));
  return { ok: true, samples };
}

/**
 * Freefall Guard — checks real-time underlying direction once per second.
 * Scalper-owned samples only; never shares with regular bot.
 *
 * FAIL-CLOSED: returns evaluable=false (NOT a clear) whenever the data is not
 * reliable enough to trust:
 *   - fewer than N+1 valid finite samples in the same-window observation range
 *   - the newest in-window sample is stale (older than FREEFALL_MAX_SAMPLE_AGE_MS)
 *   - samples are not spaced at a trustworthy one-second cadence
 *   - the live underlying is not on the contract side of the active target
 *
 * When evaluable, blocks after the configured real elapsed duration of
 * consecutive wrong-way movement: falling for YES, rising for NO. Flat or
 * favorable movement resets the trailing wrong-way streak. The separate
 * rapid-move filter may additionally block an unusually fast endpoint move in
 * either direction.
 */
export function checkFreefallGuard(input: FreefallGuardInput): FreefallGuardResult {
  const requiredMoves = Math.max(1, Math.floor(input.consecutiveSeconds));
  const rapidRequiredMoves = Math.max(1, Math.floor(input.rapidMoveLookbackSeconds));
  const longestRequiredMoves = Math.max(
    input.directionEnabled ? requiredMoves : 0,
    input.rapidMoveEnabled ? rapidRequiredMoves : 0,
    input.adverseExcursionEnabled
      ? Math.max(1, Math.floor(input.adverseExcursionLookbackSeconds ?? 0))
      : 0,
  );
  const requiredSamples = longestRequiredMoves > 0
    ? input.authoritativeCommodityCadence
      ? CONTRARIAN_COMMODITY_MIN_DISTINCT_PUBLISHES
      : longestRequiredMoves + 1
    : 0;
  const unavailable = (reason: string, samplesUsed: number): FreefallGuardResult => ({
    evaluable: false,
    blocked: false,
    reason,
    adverseMovePct: 0,
    endpointAdverseMovePct: 0,
    reversalAdverseMovePct: 0,
    samplesUsed,
    requiredSamples,
    consecutiveWrongWayMoves: 0,
    consecutiveWrongWaySeconds: 0,
    requiredConsecutiveMoves: requiredMoves,
    observedSpanMs: 0,
    directionalMovePct: 0,
    favorableTrendMinimumPct: FAVORABLE_TREND_MIN_MOVE_PCT,
    uniqueDirectionalSamples: 0,
    favorableTrendConfirmed: null,
    favorableTrendBlocked: false,
    favorableTrendReason: null,
    coordinatedDirectionClearanceApplied: false,
    coordinatedDirectionClearanceSafe: null,
    coordinatedDirectionClearanceReason: null,
    adversePacePctPerSecond: null,
    projectedAdverseMovePct: null,
    projectedDistancePct: null,
    projectedPrice: null,
    secondsRemaining: null,
    targetSideWindowConfirmed: null,
    targetSideViolationPrice: null,
    targetSideViolationAt: null,
    latestPrice: null,
    targetPrice:
      (input.directionEnabled || input.adverseExcursionEnabled)
      && Number.isFinite(input.targetPrice)
        ? input.targetPrice
        : null,
    directionalBlocked: false,
    wrongTargetSide: false,
    rapidMoveBlocked: false,
    rapidMovePct: 0,
    evaluatedSamples: [],
    wrongWayResetCount: 0,
    lastWrongWayResetAt: null,
  });

  if (!Number.isFinite(input.nowMs) || !Number.isFinite(input.eligibilityStartMs)) {
    return unavailable("freefall_unavailable_timing", 0);
  }
  if (
    (input.directionEnabled || input.adverseExcursionEnabled)
    && (!Number.isFinite(input.targetPrice) || input.targetPrice <= 0)
  ) {
    return unavailable("freefall_unavailable_target", 0);
  }
  if (
    input.directionEnabled
    && (
    !Number.isFinite(input.consecutiveSeconds)
    || input.consecutiveSeconds < 1
    )
  ) {
    return unavailable("freefall_unavailable_config", 0);
  }
  if (
    input.rapidMoveEnabled
    && (
      !Number.isFinite(input.rapidMoveLookbackSeconds)
      || input.rapidMoveLookbackSeconds < 1
      || !Number.isFinite(input.rapidMoveThresholdPct)
      || input.rapidMoveThresholdPct <= 0
    )
  ) {
    return unavailable("rapid_move_unavailable_config", 0);
  }
  if (
    input.adverseExcursionEnabled
    && (
      !Number.isInteger(input.adverseExcursionLookbackSeconds)
      || (input.adverseExcursionLookbackSeconds ?? 0) < 5
      || !Number.isFinite(input.adverseExcursionThresholdPct)
      || (input.adverseExcursionThresholdPct ?? 0) <= 0
      || !Number.isInteger(input.adverseExcursionRecoverySeconds)
      || (input.adverseExcursionRecoverySeconds ?? 0) < 1
    )
  ) {
    return unavailable("adverse_excursion_unavailable_config", 0);
  }

  const maxObservationSeconds = Math.max(
    input.directionEnabled ? requiredMoves : 0,
    input.rapidMoveEnabled ? Math.floor(input.rapidMoveLookbackSeconds) : 0,
    input.adverseExcursionEnabled
      ? Math.floor(input.adverseExcursionLookbackSeconds ?? 0)
      : 0,
  );
  const cutoff = Math.max(
    input.eligibilityStartMs,
    input.nowMs - (
      maxObservationSeconds * 1_000
      + (input.authoritativeCommodityCadence
        ? (CONTRARIAN_COMMODITY_MIN_DISTINCT_PUBLISHES - 1)
          * CONTRARIAN_COMMODITY_MAX_ORACLE_PUBLISH_GAP_MS
        : 3_000)
    ),
  );
  // Only VALID (finite, positive price; sane timestamp after the caller's
  // same-window observation boundary) samples.
  const relevant = input.samples.filter(
    (s) =>
      s != null &&
      Number.isFinite(s.price) &&
      s.price > 0 &&
      Number.isFinite(s.at) &&
      s.at >= cutoff &&
      s.at >= input.eligibilityStartMs &&
      s.at <= input.nowMs,
  );

  if (relevant.length === 0) {
    return unavailable("freefall_unavailable_no_samples", relevant.length);
  }

  for (let index = 1; index < relevant.length; index += 1) {
    if (relevant[index].at <= relevant[index - 1].at) {
      return unavailable("freefall_unavailable_out_of_order", relevant.length);
    }
  }

  const oldest = relevant[0];
  const newest = relevant[relevant.length - 1];

  // (2) Newest sample must be fresh; a stale latest price means we are blind
  // to "now" and must not treat the window as clear.
  const newestAge = input.nowMs - newest.at;
  if (newestAge > FREEFALL_MAX_SAMPLE_AGE_MS) {
    return unavailable("freefall_unavailable_stale", relevant.length);
  }

  const directional = input.directionEnabled
    ? input.authoritativeCommodityCadence
      ? selectCommodityOracleSamples(relevant, requiredMoves, input.nowMs)
      : selectCadencedSamples(relevant, requiredMoves)
    : null;
  if (directional && !directional.ok) {
    return unavailable(directional.reason, directional.samplesUsed);
  }

  const directionSamples = directional?.ok ? directional.samples : [newest];
  const excursionSelection = input.adverseExcursionEnabled
    ? input.authoritativeCommodityCadence
      ? selectCommodityOracleSamples(
        relevant,
        Math.max(1, Math.floor(input.adverseExcursionLookbackSeconds ?? 0)),
        input.nowMs,
      )
      : selectCadencedSamples(
        relevant,
        Math.max(1, Math.floor(input.adverseExcursionLookbackSeconds ?? 0)),
      )
    : null;
  if (excursionSelection && !excursionSelection.ok) {
    return unavailable(
      excursionSelection.reason.replace("freefall_", "adverse_excursion_"),
      excursionSelection.samplesUsed,
    );
  }
  const excursionSamples = excursionSelection?.ok ? excursionSelection.samples : [];
  if (
    input.requireDistinctOraclePublishTimes
    && input.adverseExcursionEnabled
    && !input.authoritativeCommodityCadence
  ) {
    const publishTimes = new Set<number>();
    for (const sample of excursionSamples) {
      const publishedAtMs = sample.oraclePublishedAtMs;
      if (
        !Number.isFinite(publishedAtMs)
        || !Number.isFinite(sample.oracleAgeMs)
        || (sample.oracleAgeMs as number) < 0
        || (sample.oracleAgeMs as number) > 5_000
      ) {
        return unavailable("adverse_excursion_unavailable_oracle_stale", excursionSamples.length);
      }
      if (publishTimes.has(publishedAtMs as number)) {
        return unavailable("adverse_excursion_unavailable_repeated_oracle_publish", excursionSamples.length);
      }
      publishTimes.add(publishedAtMs as number);
    }
  }
  let adverseExcursionPct: number | null = null;
  let adverseExcursionTriggeredAt: number | null = null;
  let adverseExcursionRecoverySamples = 0;
  let adverseExcursionExtremePrice: number | null = null;
  let adverseExcursionBlocked = false;
  if (input.adverseExcursionEnabled && excursionSamples.length > 0) {
    let extreme = excursionSamples[0].price;
    const threshold = input.adverseExcursionThresholdPct!;
    for (let index = 0; index < excursionSamples.length; index += 1) {
      const sample = excursionSamples[index];
      extreme = input.side === "yes"
        ? Math.max(extreme, sample.price)
        : Math.min(extreme, sample.price);
      const excursion = input.side === "yes"
        ? ((extreme - sample.price) / extreme) * 100
        : ((sample.price - extreme) / extreme) * 100;
      adverseExcursionPct = Math.max(adverseExcursionPct ?? 0, excursion);
      if (excursion >= threshold && adverseExcursionTriggeredAt == null) {
        adverseExcursionTriggeredAt = sample.at;
      }
      if (adverseExcursionTriggeredAt != null) {
        if (excursion < threshold) adverseExcursionRecoverySamples += 1;
        else adverseExcursionRecoverySamples = 0;
      }
    }
    adverseExcursionBlocked = adverseExcursionTriggeredAt != null
      && adverseExcursionRecoverySamples < input.adverseExcursionRecoverySeconds!;
    adverseExcursionExtremePrice = extreme;
  }
  const uniqueDirectionalSamples = new Set(
    directionSamples.map((sample) => sample.price),
  ).size;
  const directionOldest = directionSamples[0];
  const directionNewest = directionSamples[directionSamples.length - 1];
  const directionObservedSpanMs =
    directionNewest.at - directionOldest.at;
  let observedSpanMs = Math.max(
    directionObservedSpanMs,
    excursionSamples.length > 1
      ? excursionSamples[excursionSamples.length - 1].at - excursionSamples[0].at
      : 0,
  );
  const priceChangePct = input.directionEnabled
    ? ((directionNewest.price - directionOldest.price) / directionOldest.price) * 100
    : 0;
  const endpointAdverseMovePct = Math.max(
    0,
    input.side === "yes" ? -priceChangePct : priceChangePct,
  );
  let consecutiveWrongWayMoves = 0;
  let consecutiveWrongWayStartedAt: number | null = null;
  let consecutiveWrongWayDurationMs = 0;
  let wrongWayResetCount = 0;
  let lastWrongWayResetAt: number | null = null;
  for (let index = 1; index < directionSamples.length; index += 1) {
    const previousSample = directionSamples[index - 1];
    const currentSample = directionSamples[index];
    const previous = previousSample.price;
    const current = currentSample.price;
    const movedWrongWay = input.side === "yes"
      ? current < previous
      : current > previous;
    if (movedWrongWay) {
      if (consecutiveWrongWayMoves === 0) {
        consecutiveWrongWayStartedAt = previousSample.at;
      }
      consecutiveWrongWayMoves += 1;
      consecutiveWrongWayDurationMs =
        currentSample.at - (consecutiveWrongWayStartedAt ?? currentSample.at);
    } else {
      if (consecutiveWrongWayMoves > 0) {
        wrongWayResetCount += 1;
        lastWrongWayResetAt = currentSample.at;
      }
      consecutiveWrongWayMoves = 0;
      consecutiveWrongWayStartedAt = null;
      consecutiveWrongWayDurationMs = 0;
    }
  }
  const consecutiveWrongWaySeconds = consecutiveWrongWayDurationMs / 1_000;

  const latestWrongTargetSide = input.directionEnabled && (
    input.side === "yes"
      ? directionNewest.price <= input.targetPrice
      : directionNewest.price >= input.targetPrice
  );
  const directionalBlocked =
    input.directionEnabled
    && consecutiveWrongWayDurationMs >= requiredMoves * 1_000;
  const favorableTrendConfirmationEnabled =
    input.directionEnabled && input.favorableTrendConfirmationEnabled;
  const targetSideViolation = favorableTrendConfirmationEnabled
    ? directionSamples.find((sample) =>
      input.side === "yes"
        ? sample.price <= input.targetPrice
        : sample.price >= input.targetPrice
    ) ?? null
    : null;
  const targetSideWindowConfirmed = favorableTrendConfirmationEnabled
    ? targetSideViolation == null
    : null;
  const wrongTargetSide =
    latestWrongTargetSide || targetSideViolation != null;
  const favorableDirectionalMovePct =
    input.side === "yes" ? priceChangePct : -priceChangePct;
  const favorableTrendConfirmed = favorableTrendConfirmationEnabled
    ? (
      uniqueDirectionalSamples >= 2
      && favorableDirectionalMovePct >= FAVORABLE_TREND_MIN_MOVE_PCT
    )
    : null;
  const favorableTrendBlocked =
    favorableTrendConfirmationEnabled && favorableTrendConfirmed !== true;
  const favorableTrendReason = favorableTrendBlocked
    ? (input.side === "yes"
      ? "freefall_favorable_trend_not_confirmed_yes"
      : "freefall_favorable_trend_not_confirmed_no")
    : null;

  let rapidMoveBlocked = false;
  let rapidMovePct = 0;
  let rapidSamplesUsed = 0;
  let rapidSamples: FreefallSample[] = [];
  let rapidMoveReason: string | null = null;
  if (input.rapidMoveEnabled) {
    const rapid = input.authoritativeCommodityCadence
      ? selectCommodityOracleSamples(relevant, rapidRequiredMoves, input.nowMs)
      : selectCadencedSamples(relevant, rapidRequiredMoves);
    if (!rapid.ok) {
      return unavailable(
        rapid.reason.replace(/^freefall_/, "rapid_move_"),
        rapid.samplesUsed,
      );
    }
    const rapidOldest = rapid.samples[0];
    const rapidNewest = rapid.samples[rapid.samples.length - 1];
    rapidSamples = rapid.samples;
    rapidSamplesUsed = rapid.samples.length;
    observedSpanMs = Math.max(
      observedSpanMs,
      rapidNewest.at - rapidOldest.at,
    );
    const rapidSignedMovePct =
      ((rapidNewest.price - rapidOldest.price) / rapidOldest.price) * 100;
    rapidMovePct = Math.abs(rapidSignedMovePct);
    rapidMoveBlocked = rapidMovePct >= input.rapidMoveThresholdPct;
    if (rapidMoveBlocked) {
      rapidMoveReason = rapidSignedMovePct >= 0
        ? "rapid_move_too_fast_rising"
        : "rapid_move_too_fast_falling";
    }
  }

  const coordinatedDirectionClearanceEnabled =
    favorableTrendConfirmationEnabled
    && (input.coordinatedDirectionClearanceEnabled ?? false);
  let coordinatedDirectionClearanceApplied = false;
  let coordinatedDirectionClearanceSafe: boolean | null = null;
  let coordinatedDirectionClearanceReason: string | null = null;
  let adversePacePctPerSecond: number | null = null;
  let projectedAdverseMovePct: number | null = null;
  let projectedDistancePct: number | null = null;
  let projectedPrice: number | null = null;
  let secondsRemaining: number | null = null;
  // Always retain projection evidence from the same cadenced directional
  // samples.  This is diagnostic unless coordinated clearance is enabled; in
  // particular it must not change the normal guard's allow/block decision.
  // Keeping it for consecutive wrong-way blocks also lets an isolated
  // experiment consume the *existing* guard rather than create a detector.
  const projectionInputsUsable =
    input.directionEnabled
    && Number.isFinite(input.targetPrice)
    && input.targetPrice > 0
    && Number.isFinite(input.secondsRemaining)
    && (input.secondsRemaining ?? -1) >= 0
    && directionObservedSpanMs > 0;
  if (projectionInputsUsable) {
    secondsRemaining = input.secondsRemaining!;
    const observedSeconds = directionObservedSpanMs / 1_000;
    const adversePriceDelta = input.side === "yes"
      ? Math.max(0, directionOldest.price - directionNewest.price)
      : Math.max(0, directionNewest.price - directionOldest.price);
    const adversePricePerSecond = adversePriceDelta / observedSeconds;
    adversePacePctPerSecond =
      (adversePricePerSecond / input.targetPrice) * 100;
    projectedAdverseMovePct =
      adversePacePctPerSecond * secondsRemaining;
    projectedPrice = input.side === "yes"
      ? directionNewest.price - adversePricePerSecond * secondsRemaining
      : directionNewest.price + adversePricePerSecond * secondsRemaining;
    projectedDistancePct = input.side === "yes"
      ? ((projectedPrice - input.targetPrice) / input.targetPrice) * 100
      : ((input.targetPrice - projectedPrice) / input.targetPrice) * 100;
  }
  // Preserve the excursion's adverse pace across a single favorable rebound.
  // This projection is only a diagnostic/admission input; target crossing is
  // still independently required by the strict Contrarian classifier.
  if (
    adverseExcursionBlocked
    && adverseExcursionExtremePrice != null
    && adverseExcursionTriggeredAt != null
    && Number.isFinite(input.secondsRemaining)
    && (input.secondsRemaining ?? -1) >= 0
  ) {
    secondsRemaining = input.secondsRemaining!;
    const elapsedSeconds = Math.max(
      1,
      (directionNewest.at - adverseExcursionTriggeredAt) / 1_000,
    );
    const adverseDelta = input.side === "yes"
      ? Math.max(0, adverseExcursionExtremePrice - directionNewest.price)
      : Math.max(0, directionNewest.price - adverseExcursionExtremePrice);
    const excursionPace = adverseDelta / elapsedSeconds;
    if (excursionPace > 0) {
      adversePacePctPerSecond = (excursionPace / input.targetPrice) * 100;
      projectedAdverseMovePct =
        adversePacePctPerSecond * input.secondsRemaining!;
      projectedPrice = input.side === "yes"
        ? directionNewest.price - excursionPace * input.secondsRemaining!
        : directionNewest.price + excursionPace * input.secondsRemaining!;
      projectedDistancePct = input.side === "yes"
        ? ((projectedPrice - input.targetPrice) / input.targetPrice) * 100
        : ((input.targetPrice - projectedPrice) / input.targetPrice) * 100;
    }
  }
  if (
    coordinatedDirectionClearanceEnabled
    && favorableTrendBlocked
    && !wrongTargetSide
    && !directionalBlocked
    && !adverseExcursionBlocked
    && !rapidMoveBlocked
  ) {
    const targetGuardEnabled = input.targetProximityGuardEnabled ?? false;
    const minimumPct = input.targetProximityThresholdPct;
    const remaining = input.secondsRemaining;
    if (!targetGuardEnabled) {
      coordinatedDirectionClearanceSafe = false;
      coordinatedDirectionClearanceReason =
        "coordinated_direction_clearance_requires_target_guard";
    } else if (
      !Number.isFinite(minimumPct)
      || (minimumPct ?? 0) <= 0
      || !Number.isFinite(remaining)
      || (remaining ?? -1) < 0
      || !projectionInputsUsable
    ) {
      coordinatedDirectionClearanceSafe = false;
      coordinatedDirectionClearanceReason =
        "coordinated_direction_clearance_unavailable";
    } else {
      coordinatedDirectionClearanceSafe = projectedDistancePct! > minimumPct!;
      // A genuinely stable target-side window is safe to clear when its
      // projected distance remains beyond the mandatory proximity threshold.
      // Keep this deliberately narrow: any adverse tick/reset still requires
      // the normal meaningful favorable movement confirmation.
      const stableTargetSideWindow =
        endpointAdverseMovePct === 0
        && consecutiveWrongWayMoves === 0
        && wrongWayResetCount === 0;
      coordinatedDirectionClearanceApplied =
        coordinatedDirectionClearanceSafe && stableTargetSideWindow;
      coordinatedDirectionClearanceReason = coordinatedDirectionClearanceApplied
        ? (input.side === "yes"
          ? "coordinated_direction_clearance_stable_safe_yes"
          : "coordinated_direction_clearance_stable_safe_no")
        : coordinatedDirectionClearanceSafe
          ? (input.side === "yes"
            ? "coordinated_direction_clearance_requires_favorable_minimum_yes"
            : "coordinated_direction_clearance_requires_favorable_minimum_no")
          : (input.side === "yes"
            ? "coordinated_direction_clearance_projected_too_close_yes"
            : "coordinated_direction_clearance_projected_too_close_no");
    }
  }

  const effectiveFavorableTrendBlocked =
    favorableTrendBlocked && !coordinatedDirectionClearanceApplied;
  const blocked =
    wrongTargetSide
    || directionalBlocked
    || adverseExcursionBlocked
    || effectiveFavorableTrendBlocked
    || rapidMoveBlocked;
  const reason = wrongTargetSide
    ? (input.side === "yes"
      ? "freefall_wrong_target_side_yes"
      : "freefall_wrong_target_side_no")
    : directionalBlocked
      ? (input.side === "yes"
        ? "freefall_consecutive_falling"
        : "freefall_consecutive_rising")
      : adverseExcursionBlocked
        ? (input.side === "yes"
          ? "adverse_excursion_peak_fall_yes"
          : "adverse_excursion_trough_rise_no")
      : effectiveFavorableTrendBlocked
        ? (
          coordinatedDirectionClearanceSafe === false
            ? coordinatedDirectionClearanceReason ?? favorableTrendReason
            : favorableTrendReason
        )
        : rapidMoveReason;
  const evaluatedSamplesByTimestamp = new Map<number, FreefallSample>();
  if (input.directionEnabled) {
    for (const sample of directionSamples) evaluatedSamplesByTimestamp.set(sample.at, sample);
  }
  if (input.rapidMoveEnabled) {
    for (const sample of rapidSamples) evaluatedSamplesByTimestamp.set(sample.at, sample);
  }
  if (input.adverseExcursionEnabled) {
    for (const sample of excursionSamples) evaluatedSamplesByTimestamp.set(sample.at, sample);
  }
  const evaluatedSamples = [...evaluatedSamplesByTimestamp.values()]
    .sort((a, b) => a.at - b.at);

  return {
    evaluable: true,
    blocked,
    reason,
    adverseMovePct: Math.max(endpointAdverseMovePct, adverseExcursionPct ?? 0),
    endpointAdverseMovePct,
    reversalAdverseMovePct: adverseExcursionPct ?? 0,
    samplesUsed: Math.max(
      input.directionEnabled ? directionSamples.length : 0,
      rapidSamplesUsed,
      excursionSamples.length,
    ),
    requiredSamples,
    consecutiveWrongWayMoves,
    consecutiveWrongWaySeconds,
    requiredConsecutiveMoves: requiredMoves,
    observedSpanMs,
    directionalMovePct: priceChangePct,
    favorableTrendMinimumPct: FAVORABLE_TREND_MIN_MOVE_PCT,
    uniqueDirectionalSamples,
    favorableTrendConfirmed,
    favorableTrendBlocked,
    favorableTrendReason,
    coordinatedDirectionClearanceApplied,
    coordinatedDirectionClearanceSafe,
    coordinatedDirectionClearanceReason,
    adversePacePctPerSecond,
    projectedAdverseMovePct,
    projectedDistancePct,
    projectedPrice,
    secondsRemaining,
    targetSideWindowConfirmed,
    targetSideViolationPrice: targetSideViolation?.price ?? null,
    targetSideViolationAt: targetSideViolation?.at ?? null,
    latestPrice: directionNewest.price,
    targetPrice:
      input.directionEnabled || input.adverseExcursionEnabled
        ? input.targetPrice
        : null,
    directionalBlocked,
    wrongTargetSide,
    rapidMoveBlocked,
    rapidMovePct,
    evaluatedSamples,
    wrongWayResetCount,
    lastWrongWayResetAt,
    adverseExcursionBlocked,
    adverseExcursionPct,
    adverseExcursionLookbackSeconds: input.adverseExcursionEnabled
      ? input.adverseExcursionLookbackSeconds ?? null
      : null,
    adverseExcursionRecoverySeconds: input.adverseExcursionEnabled
      ? input.adverseExcursionRecoverySeconds ?? null
      : null,
    adverseExcursionRecoverySamples,
    adverseExcursionTriggeredAt,
  };
}

/**
 * Authoritative Freefall decision used at the final pre-submit boundary.
 *
 * This keeps the live service and the controlled integration exercise on the
 * same production decision path. Missing product metadata, a failed fresh
 * underlying fetch, stale/insufficient samples, and an adverse move all fail
 * closed. Callers must return before creating an order intent when allowed=false.
 */
export function evaluateFreefallPreSubmitGuard(input: {
  directionEnabled: boolean;
  hasProduct: boolean;
  freshSampleSucceeded: boolean;
  samples: FreefallSample[];
  side: "yes" | "no";
  nowMs: number;
  eligibilityStartMs: number;
  consecutiveSeconds: number;
  favorableTrendConfirmationEnabled: boolean;
  coordinatedDirectionClearanceEnabled?: boolean;
  targetPrice: number;
  targetProximityGuardEnabled?: boolean;
  targetProximityThresholdPct?: number;
  secondsRemaining?: number;
  rapidMoveEnabled: boolean;
  rapidMoveLookbackSeconds: number;
  rapidMoveThresholdPct: number;
  adverseExcursionEnabled?: boolean;
  adverseExcursionLookbackSeconds?: number;
  adverseExcursionThresholdPct?: number;
  adverseExcursionRecoverySeconds?: number;
  requireDistinctOraclePublishTimes?: boolean;
  authoritativeCommodityCadence?: boolean;
}): FreefallPreSubmitDecision {
  const baselineEnabled = input.directionEnabled || input.rapidMoveEnabled;
  const excursionEnabled = input.adverseExcursionEnabled === true;
  if (!baselineEnabled && !excursionEnabled) {
    return {
      allowed: true,
      reason: null,
      guardResult: null,
      sampleCoverageMs: null,
    };
  }

  // The established directional/rapid guards remain fail-closed. The optional
  // excursion layer is additive: if it cannot evaluate, it must not turn an
  // otherwise valid Scalper entry into a permanent skip.
  if (!input.hasProduct && baselineEnabled) {
    return {
      allowed: false,
      reason: "freefall_unavailable_no_product",
      guardResult: null,
      sampleCoverageMs: null,
    };
  }

  // A fresh fetch failure is authoritative. Never let older cached samples
  // hide the fact that the guard cannot see the current underlying price.
  if (!input.freshSampleSucceeded && baselineEnabled) {
    return {
      allowed: false,
      reason: "freefall_unavailable_fetch_failed",
      guardResult: null,
      sampleCoverageMs: null,
    };
  }

  const evaluate = (overrides: {
    directionEnabled: boolean;
    rapidMoveEnabled: boolean;
    adverseExcursionEnabled: boolean;
  }) => checkFreefallGuard({
    samples: input.samples,
    side: input.side,
    nowMs: input.nowMs,
    directionEnabled: overrides.directionEnabled,
    eligibilityStartMs: input.eligibilityStartMs,
    consecutiveSeconds: input.consecutiveSeconds,
    favorableTrendConfirmationEnabled: input.favorableTrendConfirmationEnabled,
    coordinatedDirectionClearanceEnabled:
      input.coordinatedDirectionClearanceEnabled,
    targetPrice: input.targetPrice,
    targetProximityGuardEnabled: input.targetProximityGuardEnabled,
    targetProximityThresholdPct: input.targetProximityThresholdPct,
    secondsRemaining: input.secondsRemaining,
    rapidMoveEnabled: overrides.rapidMoveEnabled,
    rapidMoveLookbackSeconds: input.rapidMoveLookbackSeconds,
    rapidMoveThresholdPct: input.rapidMoveThresholdPct,
    adverseExcursionEnabled: overrides.adverseExcursionEnabled,
    adverseExcursionLookbackSeconds: input.adverseExcursionLookbackSeconds,
    adverseExcursionThresholdPct: input.adverseExcursionThresholdPct,
    adverseExcursionRecoverySeconds: input.adverseExcursionRecoverySeconds,
    requireDistinctOraclePublishTimes: input.requireDistinctOraclePublishTimes,
    authoritativeCommodityCadence: input.authoritativeCommodityCadence,
  });

  const baselineResult = baselineEnabled
    ? evaluate({
      directionEnabled: input.directionEnabled,
      rapidMoveEnabled: input.rapidMoveEnabled,
      adverseExcursionEnabled: false,
    })
    : null;
  if (baselineResult && (!baselineResult.evaluable || baselineResult.blocked)) {
    return {
      allowed: false,
      reason: baselineResult.reason ?? "freefall_blocked_final",
      guardResult: baselineResult,
      sampleCoverageMs: baselineResult.observedSpanMs || null,
    };
  }

  if (excursionEnabled) {
    // Evaluate the optional layer independently so warming/cadence gaps cannot
    // mask a valid baseline result. Only a positively evaluated excursion may
    // veto a normal Scalper entry. Contrarian uses its own strict classifier
    // and continues to fail closed on unavailable commodity evidence.
    const excursionResult = evaluate({
      directionEnabled: false,
      rapidMoveEnabled: false,
      adverseExcursionEnabled: true,
    });
    if (excursionResult.evaluable && excursionResult.blocked) {
      return {
        allowed: false,
        reason: excursionResult.reason ?? "adverse_excursion_blocked_final",
        guardResult: excursionResult,
        sampleCoverageMs: excursionResult.observedSpanMs || null,
      };
    }
    if (!excursionResult.evaluable) {
      return {
        allowed: true,
        reason: null,
        guardResult: baselineResult,
        sampleCoverageMs: baselineResult?.observedSpanMs || null,
      };
    }
  }

  const result = evaluate({
    directionEnabled: input.directionEnabled,
    rapidMoveEnabled: input.rapidMoveEnabled,
    adverseExcursionEnabled: excursionEnabled,
  });
  return {
    allowed: result.evaluable && !result.blocked,
    reason: result.evaluable && !result.blocked
      ? null
      : result.reason ?? "freefall_blocked_final",
    guardResult: result,
    sampleCoverageMs: result.observedSpanMs || null,
  };
}
export interface TargetProximityGuardResult {
  /** False means the enabled guard cannot prove the entry safe. */
  evaluable: boolean;
  blocked: boolean;
  reason: string | null;
  /** Absolute live-vs-target distance as a percentage of the Kalshi target. */
  distancePct: number | null;
}

/**
 * Block when the fresh underlying price is too close to the force-refreshed
 * Kalshi target. This guard is side-independent: when the outcome is nearly
 * balanced around the strike, the Scalper stays away entirely.
 */
export function checkTargetProximityGuard(
  livePrice: number | null | undefined,
  kalshiTarget: number | null | undefined,
  thresholdPct: number,
): TargetProximityGuardResult {
  const unavailable = (reason: string): TargetProximityGuardResult => ({
    evaluable: false,
    blocked: false,
    reason,
    distancePct: null,
  });

  if (!Number.isFinite(livePrice) || (livePrice ?? 0) <= 0) {
    return unavailable("target_proximity_unavailable_live_price");
  }
  if (!Number.isFinite(kalshiTarget) || (kalshiTarget ?? 0) <= 0) {
    return unavailable("target_proximity_unavailable_target");
  }
  if (!Number.isFinite(thresholdPct) || thresholdPct <= 0) {
    return unavailable("target_proximity_unavailable_threshold");
  }

  const distancePct = (Math.abs(livePrice! - kalshiTarget!) / kalshiTarget!) * 100;
  const blocked = distancePct <= thresholdPct;
  return {
    evaluable: true,
    blocked,
    reason: blocked ? "target_proximity_too_close" : null,
    distancePct,
  };
}

export function resolveScalpMarketState(input: {
  paused: boolean;
  hasQuote: boolean;
  hasMatch: boolean;
  inWindow: boolean;
  guardBlocked: boolean;
}): ScalpMarketStatus["state"] {
  if (input.paused) return "paused";
  if (!input.hasQuote) return "no_quote";
  if (!input.hasMatch) return "out_of_band";
  if (input.inWindow && input.guardBlocked) return "guarded";
  return input.inWindow ? "active" : "ready";
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
  openCapDollars: number,
  currentOpenCommitted: number,
  orderBudget: number,
): CapCheckResult {
  const effectiveOpenCapDollars = normalizeScalpOpenCapDollars(openCapDollars);
  if (currentOpenCommitted + orderBudget > effectiveOpenCapDollars) {
    return {
      allowed: false,
      reason: `open_cap_exceeded (open=${currentOpenCommitted.toFixed(2)} cap=${effectiveOpenCapDollars})`,
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
 * time). Only the daily cap may be null ("no daily limit"). Open exposure is
 * always normalized to a finite ceiling. The comparison is strict `>` so the
 * total is allowed to reach the cap exactly.
 */
export function evaluateCapDecision(
  requestedBudget: number,
  dailyCommitted: number,
  openCommitted: number,
  dailyCapDollars: number | null,
  openCapDollars: number,
): CapDecision {
  const effectiveOpenCapDollars = normalizeScalpOpenCapDollars(openCapDollars);
  if (dailyCapDollars != null && dailyCommitted + requestedBudget > dailyCapDollars) {
    return {
      allowed: false,
      reason: `daily_cap_exceeded (committed=${dailyCommitted.toFixed(2)} cap=${dailyCapDollars})`,
    };
  }
  if (openCommitted + requestedBudget > effectiveOpenCapDollars) {
    return {
      allowed: false,
      reason: `open_cap_exceeded (open=${openCommitted.toFixed(2)} cap=${effectiveOpenCapDollars})`,
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
  openCapDollars: number;
  // Freefall guard config
  freefallGuardEnabled: boolean;
  freefallConsecutiveSeconds: number;
  favorableTrendConfirmationEnabled: boolean;
  coordinatedDirectionClearanceEnabled: boolean;
  adverseExcursionGuardEnabled: boolean;
  adverseExcursionLookbackSeconds: number;
  adverseExcursionThresholdPct: number;
  adverseExcursionRecoverySeconds: number;
  freefallLookbackSeconds: number;
  freefallThresholdPct: number;
  rapidMoveGuardEnabled: boolean;
  rapidMoveLookbackSeconds: number;
  rapidMoveThresholdPct: number;
  // Target proximity guard config
  targetProximityGuardEnabled: boolean;
  targetProximityThresholdPct: number;
  // Enablement
  enabled: boolean;
}

/** Minimal shape of the config fields the snapshot depends on. */
export interface RiskConfigLike {
  enabled: boolean;
  mode: "paper" | "live";
  dailyCapDollars: number | null;
  openCapDollars: number;
  freefallGuardEnabled: boolean;
  freefallConsecutiveSeconds?: number;
  favorableTrendConfirmationEnabled?: boolean;
  coordinatedDirectionClearanceEnabled?: boolean;
  adverseExcursionGuardEnabled?: boolean;
  adverseExcursionLookbackSeconds?: number;
  adverseExcursionThresholdPct?: number;
  adverseExcursionRecoverySeconds?: number;
  freefallLookbackSeconds: number;
  freefallThresholdPct: number;
  rapidMoveGuardEnabled?: boolean;
  rapidMoveLookbackSeconds?: number;
  rapidMoveThresholdPct?: number;
  targetProximityGuardEnabled: boolean;
  targetProximityThresholdPct: number;
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
    freefallConsecutiveSeconds: config.freefallConsecutiveSeconds ?? 4,
    favorableTrendConfirmationEnabled:
      config.favorableTrendConfirmationEnabled ?? true,
    coordinatedDirectionClearanceEnabled:
      config.coordinatedDirectionClearanceEnabled ?? false,
    adverseExcursionGuardEnabled:
      config.adverseExcursionGuardEnabled ?? false,
    adverseExcursionLookbackSeconds:
      config.adverseExcursionLookbackSeconds ?? 20,
    adverseExcursionThresholdPct:
      config.adverseExcursionThresholdPct ?? 0.1,
    adverseExcursionRecoverySeconds:
      config.adverseExcursionRecoverySeconds ?? 3,
    freefallLookbackSeconds: config.freefallLookbackSeconds,
    freefallThresholdPct: config.freefallThresholdPct,
    rapidMoveGuardEnabled: config.rapidMoveGuardEnabled ?? false,
    rapidMoveLookbackSeconds: config.rapidMoveLookbackSeconds ?? 4,
    rapidMoveThresholdPct: config.rapidMoveThresholdPct ?? 0.5,
    targetProximityGuardEnabled: config.targetProximityGuardEnabled,
    targetProximityThresholdPct: config.targetProximityThresholdPct,
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
  if (!eqNum(currentConfig.openCapDollars, snapshot.openCapDollars)) changed.push("openCapDollars");

  // Freefall config
  if (currentConfig.freefallGuardEnabled !== snapshot.freefallGuardEnabled) changed.push("freefallGuardEnabled");
  if (!eqNum(currentConfig.freefallConsecutiveSeconds ?? 4, snapshot.freefallConsecutiveSeconds)) changed.push("freefallConsecutiveSeconds");
  if (
    (currentConfig.favorableTrendConfirmationEnabled ?? true)
    !== snapshot.favorableTrendConfirmationEnabled
  ) {
    changed.push("favorableTrendConfirmationEnabled");
  }
  if (
    (currentConfig.coordinatedDirectionClearanceEnabled ?? false)
    !== snapshot.coordinatedDirectionClearanceEnabled
  ) {
    changed.push("coordinatedDirectionClearanceEnabled");
  }
  if (!eqNum(currentConfig.freefallLookbackSeconds, snapshot.freefallLookbackSeconds)) changed.push("freefallLookbackSeconds");
  if (!eqNum(currentConfig.freefallThresholdPct, snapshot.freefallThresholdPct)) changed.push("freefallThresholdPct");
  if ((currentConfig.adverseExcursionGuardEnabled ?? false) !== snapshot.adverseExcursionGuardEnabled) changed.push("adverseExcursionGuardEnabled");
  if (!eqNum(currentConfig.adverseExcursionLookbackSeconds ?? 20, snapshot.adverseExcursionLookbackSeconds)) changed.push("adverseExcursionLookbackSeconds");
  if (!eqNum(currentConfig.adverseExcursionThresholdPct ?? 0.1, snapshot.adverseExcursionThresholdPct)) changed.push("adverseExcursionThresholdPct");
  if (!eqNum(currentConfig.adverseExcursionRecoverySeconds ?? 3, snapshot.adverseExcursionRecoverySeconds)) changed.push("adverseExcursionRecoverySeconds");
  if ((currentConfig.rapidMoveGuardEnabled ?? false) !== snapshot.rapidMoveGuardEnabled) changed.push("rapidMoveGuardEnabled");
  if (!eqNum(currentConfig.rapidMoveLookbackSeconds ?? 4, snapshot.rapidMoveLookbackSeconds)) changed.push("rapidMoveLookbackSeconds");
  if (!eqNum(currentConfig.rapidMoveThresholdPct ?? 0.5, snapshot.rapidMoveThresholdPct)) changed.push("rapidMoveThresholdPct");
  if (currentConfig.targetProximityGuardEnabled !== snapshot.targetProximityGuardEnabled) changed.push("targetProximityGuardEnabled");
  if (!eqNum(currentConfig.targetProximityThresholdPct, snapshot.targetProximityThresholdPct)) changed.push("targetProximityThresholdPct");

  return {
    unchanged: changed.length === 0,
    changedFields: changed,
    reason: changed.length > 0 ? `risk_changed:${changed[0]}` : null,
  };
}

/**
 * Worst-case actual submit exposure for a limit IOC buy: contractCount priced
 * at the maximum winning cost. This is the maximum dollars that could be spent if
 * the whole order fills at the limit.
 */
export function maxSubmitExposure(contractCount: number, maxWinningCost: number): number {
  if (!Number.isFinite(contractCount) || contractCount <= 0) return 0;
  if (!Number.isFinite(maxWinningCost) || maxWinningCost <= 0) return 0;
  return contractCount * maxWinningCost;
}

/** Standard 2026 Kalshi taker-fee coefficient (7%). No series-specific fee
 * source exists in this project. Series with lower or zero fees are therefore
 * safely over-reserved. */
export const SCALP_STANDARD_TAKER_FEE_BASIS_POINTS = 700;
export const SCALP_BALANCE_SAFETY_MARGIN_CENTS = 1;

/**
 * Canonical worst-case IOC taker fee, rounded upward to whole cents.
 *
 * The submitted price is always YES-side, including a NO buy. Integer cents
 * and BigInt arithmetic implement ceil(0.07 * C * P * (1-P) * 100) without
 * binary floating-point comparisons.
 */
export function estimateScalpWorstCaseTakerFeeCents(
  contractCount: number,
  yesSideLimitPrice: number,
): number {
  if (!Number.isSafeInteger(contractCount) || contractCount <= 0) return 0;
  if (!Number.isFinite(yesSideLimitPrice)) return 0;
  const yesPriceCents = Math.round(yesSideLimitPrice * 100);
  if (yesPriceCents < 1 || yesPriceCents > 99) return 0;
  const numerator =
    BigInt(SCALP_STANDARD_TAKER_FEE_BASIS_POINTS)
    * BigInt(contractCount)
    * BigInt(yesPriceCents)
    * BigInt(100 - yesPriceCents);
  // coefficient basis points / 10_000, prices / 100 each, dollars -> cents:
  // denominator = 10_000 * 100 * 100 / 100 = 1_000_000.
  const denominator = 1_000_000n;
  return Number((numerator + denominator - 1n) / denominator);
}

export interface SizedOrderResult {
  contractCount: number;
  /** Cent-quantized worst acceptable winning-contract cost. */
  maxWinningCost: number;
  principalExposureCents: number;
  estimatedFeeCents: number;
  budgetRequiredCents: number;
  principalExposure: number;
  estimatedFee: number;
  budgetRequired: number;
  /** Backward-compatible alias for principal exposure only. */
  maxExposure: number;
  /** true when a submittable order (>=1 contract) fits within reservedBudget. */
  ok: boolean;
  reason: string | null;
}

/**
 * Size an order strictly within the durable reserved budget.
 *
 * Starts from the principal-only upper bound, then reduces count until
 * principal plus the upward-rounded worst-case taker fee fits. The explicit
 * integer-cent post-condition ensures sizing can never exceed the reservation.
 */
export function sizeOrderWithinReservedBudget(
  reservedBudget: number,
  winningAsk: number,
  bandMax: number,
): SizedOrderResult {
  const fail = (reason: string): SizedOrderResult => ({
    contractCount: 0,
    maxWinningCost: 0,
    principalExposureCents: 0,
    estimatedFeeCents: 0,
    budgetRequiredCents: 0,
    principalExposure: 0,
    estimatedFee: 0,
    budgetRequired: 0,
    maxExposure: 0,
    ok: false,
    reason,
  });

  if (!Number.isFinite(reservedBudget) || reservedBudget <= 0) return fail("reserved_budget_invalid");
  if (!Number.isFinite(winningAsk) || winningAsk <= 0 || winningAsk >= 1) return fail("winning_ask_invalid");
  if (!Number.isFinite(bandMax) || bandMax < 0.01 || bandMax >= 1) return fail("band_max_invalid");
  if (winningAsk > bandMax + 1e-9) return fail("winning_ask_above_band_max");

  // Size against the same cent-quantized worst-case winning cost used by the
  // actual IOC limit—not the transient quote that selected the candidate.
  const maxWinningCost = computeLimitPrice("yes", bandMax);
  const maxWinningCostCents = Math.round(maxWinningCost * 100);
  const reservedBudgetCents = Math.floor(reservedBudget * 100 + 1e-9);
  let contractCount = Math.floor(reservedBudgetCents / maxWinningCostCents);
  let principalExposureCents = 0;
  let estimatedFeeCents = 0;
  let budgetRequiredCents = 0;
  while (contractCount > 0) {
    principalExposureCents = contractCount * maxWinningCostCents;
    // Fee is symmetric at complementary YES prices, so using the YES-side
    // winning cap here produces the same fee as a NO order's submitted limit.
    estimatedFeeCents = estimateScalpWorstCaseTakerFeeCents(
      contractCount,
      maxWinningCost,
    );
    budgetRequiredCents = principalExposureCents + estimatedFeeCents;
    if (budgetRequiredCents <= reservedBudgetCents) break;
    contractCount -= 1;
  }
  if (contractCount < 1) return fail("contract_count_zero");

  const principalExposure = principalExposureCents / 100;
  const estimatedFee = estimatedFeeCents / 100;
  const budgetRequired = budgetRequiredCents / 100;
  const maxExposure = principalExposure;

  // Hard post-condition: exposure must not exceed the reserved budget. If it
  // somehow does (impossible with floor division, but assert defensively), fail
  // closed rather than risk overspending the durable reservation.
  if (budgetRequiredCents > reservedBudgetCents) {
    return fail("exposure_exceeds_reserved_budget");
  }

  return {
    contractCount,
    maxWinningCost,
    principalExposureCents,
    estimatedFeeCents,
    budgetRequiredCents,
    principalExposure,
    estimatedFee,
    budgetRequired,
    maxExposure,
    ok: true,
    reason: null,
  };
}

export interface ScalpLiveBalanceDecision {
  allowed: boolean;
  availableBalanceCents: number | null;
  principalExposureCents: number;
  estimatedFeeCents: number;
  safetyMarginCents: number;
  totalRequiredCents: number;
}

/** Integer-cent final balance boundary. The extra cent is intentionally not
 * part of order sizing: it protects the final live gate from balance movement
 * and account rounding immediately before POST. */
export function evaluateScalpLiveBalance(
  availableBalance: number | null,
  sized: Pick<SizedOrderResult, "principalExposureCents" | "estimatedFeeCents">,
): ScalpLiveBalanceDecision {
  const safetyMarginCents = SCALP_BALANCE_SAFETY_MARGIN_CENTS;
  const totalRequiredCents =
    sized.principalExposureCents + sized.estimatedFeeCents + safetyMarginCents;
  const availableBalanceCents =
    availableBalance != null && Number.isFinite(availableBalance) && availableBalance >= 0
      ? Math.round(availableBalance * 100)
      : null;
  return {
    allowed:
      availableBalanceCents != null
      && availableBalanceCents >= totalRequiredCents,
    availableBalanceCents,
    principalExposureCents: sized.principalExposureCents,
    estimatedFeeCents: sized.estimatedFeeCents,
    safetyMarginCents,
    totalRequiredCents,
  };
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
 *      null / non-finite / <=0 / >=1           → "unknown"     (response cannot
 *                                                 be fully verified)
 *
 * A "confirmed_fill" is the ONLY classification that permits computing P&L and
 * releasing the reservation. "unknown" means contracts may have been bought at
 * an indeterminate price — never zero-fill it and never release the budget.
 *
 * filledCount MUST be a finite nonnegative FixedPointCount with at most two
 * decimal places. Kalshi supports fractional fills down to 0.01 contracts.
 * When requestedCount is supplied it must remain a positive integer and an
 * overfill is classified "unknown".
 */
export function classifyPlaceOrderResult(
  input: PlaceOrderResultInput,
): PlaceOrderClassification {
  const { filledCount, avgFillPrice, requestedCount } = input;

  const parsedFilledCount = parseFixedPointCount(filledCount);
  if (parsedFilledCount == null) {
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
      parsedFilledCount.hundredths > requestedCount * 100
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
  orderId: string | null;        // independently validated non-empty exchange id
  filledCount: number | null;    // validated nonnegative fixed-point count, else null
  avgFillPrice: number | null;   // validated (0,1) fraction, else null
}

/**
 * Parse Kalshi FixedPointCount into exact hundredths before exposing a number.
 * Current V2 responses may contain fractional contract fills down to 0.01 even
 * when the submitted order count was integral. Binary-float tolerance is never
 * used for validation.
 */
function parseFixedPointCount(v: unknown): { value: number; hundredths: number } | null {
  if (typeof v === "number") {
    if (!Number.isFinite(v) || v < 0) return null;
    const hundredths = Math.round(v * 100);
    if (!Number.isSafeInteger(hundredths) || Math.abs(v * 100 - hundredths) > 1e-8) return null;
    return { value: hundredths / 100, hundredths };
  }
  if (typeof v === "string") {
    const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(v);
    if (!m) return null;
    const whole = Number(m[1]);
    if (!Number.isSafeInteger(whole)) return null;
    const fraction = (m[2] ?? "").padEnd(2, "0");
    const hundredths = whole * 100 + Number(fraction || "0");
    if (!Number.isSafeInteger(hundredths)) return null;
    return { value: hundredths / 100, hundredths };
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
  const fail = (
    reason: string,
    partial: Partial<Pick<ParsedScalpFill, "orderId" | "filledCount" | "avgFillPrice">> = {},
  ): ParsedScalpFill => ({
    outcome: "unknown",
    reason,
    orderId: partial.orderId ?? null,
    filledCount: partial.filledCount ?? null,
    avgFillPrice: partial.avgFillPrice ?? null,
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
    return fail("missing_fill_count", { orderId });
  }
  const parsedFill = parseFixedPointCount(rawFill);
  if (parsedFill == null) {
    return fail("unparseable_fill_count", { orderId });
  }

  // Overfill is impossible.
  if (parsedFill.hundredths > requestedCount * 100) {
    return fail("overfill_count", { orderId, filledCount: parsedFill.value });
  }
  const filledCount = parsedFill.value;

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
    return fail("missing_avg_price", { orderId, filledCount });
  }
  const avg = parseFixedPointNumber(rawAvg);
  if (avg == null || avg <= 0 || avg >= 1) {
    return fail("invalid_avg_price", {
      orderId,
      filledCount,
      avgFillPrice: avg != null && Number.isFinite(avg) ? avg : null,
    });
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
// Fill-band classification (for execution records + circuit breaker)
// ---------------------------------------------------------------------------

/**
 * Classify an actual winning-contract fill against the configured entry band.
 *
 * The upper boundary is the execution safety limit: paying more than bandMax
 * is an adverse limit breach. The lower boundary is only an entry-selection
 * threshold, so a fill below bandMin is favorable price improvement and must
 * never trip the circuit breaker.
 *
 * Winning-contract cost:
 *   YES: avgFillPrice         (YES-side fraction from exchange)
 *   NO:  1 - avgFillPrice     (NO contract cost = complement of YES-side avg)
 */
export type ScalpFillBandClassification =
  | "within_band"
  | "favorable_price_improvement"
  | "adverse_limit_breach";

export interface ScalpFillBandResult {
  classification: ScalpFillBandClassification;
  winningContractCost: number;
}

export function classifyScalpFillAgainstBand(
  side: "yes" | "no",
  avgFillPrice: number,
  bandMin: number,
  bandMax: number,
): ScalpFillBandResult {
  const winningContractCost = winningCostFromFill(side, avgFillPrice);
  const classification =
    winningContractCost > bandMax
      ? "adverse_limit_breach"
      : winningContractCost < bandMin
        ? "favorable_price_improvement"
        : "within_band";
  return { classification, winningContractCost };
}

/**
 * Backward-compatible boolean band check for callers that only need to know
 * whether the fill remained between both configured boundaries.
 */
export function isFillWithinBand(
  side: "yes" | "no",
  avgFillPrice: number,   // YES-side fraction as returned by placeOrder
  bandMin: number,
  bandMax: number,
): boolean {
  return classifyScalpFillAgainstBand(side, avgFillPrice, bandMin, bandMax)
    .classification === "within_band";
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
  // Daily cap may be explicitly cleared. Open exposure is mandatory, but the
  // operator chooses its amount; the atomic claim enforces that exact value.
  if (c["dailyCapDollars"] != null && c["dailyCapDollars"] !== null) {
    const v = Number(c["dailyCapDollars"]);
    if (!Number.isFinite(v) || v <= 0) errors.push("dailyCapDollars must be > 0 when set");
  }
  if (Object.prototype.hasOwnProperty.call(c, "openCapDollars")) {
    const v = c["openCapDollars"];
    if (
      typeof v !== "number"
      || !Number.isFinite(v)
      || v <= 0
    ) {
       errors.push("openCapDollars must be a finite number > 0");
    }
  }
  if (c["mode"] != null && c["mode"] !== "paper" && c["mode"] !== "live") {
    errors.push("mode must be 'paper' or 'live'");
  }
  if (c["freefallLookbackSeconds"] != null) {
    const v = Number(c["freefallLookbackSeconds"]);
    if (!Number.isFinite(v) || v < 1 || v > 600) errors.push("freefallLookbackSeconds must be 1-600");
  }
  if (c["freefallConsecutiveSeconds"] != null) {
    const v = Number(c["freefallConsecutiveSeconds"]);
    if (!Number.isInteger(v) || v < 1 || v > 15) errors.push("freefallConsecutiveSeconds must be an integer 1-15");
  }
  if (c["freefallThresholdPct"] != null) {
    const v = Number(c["freefallThresholdPct"]);
    if (!Number.isFinite(v) || v <= 0) errors.push("freefallThresholdPct must be > 0");
  }
  if (c["adverseExcursionLookbackSeconds"] != null) {
    const v = Number(c["adverseExcursionLookbackSeconds"]);
    if (!Number.isInteger(v) || v < 5 || v > 60) errors.push("adverseExcursionLookbackSeconds must be an integer 5-60");
  }
  if (c["adverseExcursionThresholdPct"] != null) {
    const v = Number(c["adverseExcursionThresholdPct"]);
    if (!Number.isFinite(v) || v <= 0 || v > 10) errors.push("adverseExcursionThresholdPct must be > 0 and ≤ 10");
  }
  if (c["adverseExcursionRecoverySeconds"] != null) {
    const v = Number(c["adverseExcursionRecoverySeconds"]);
    if (!Number.isInteger(v) || v < 1 || v > 15) errors.push("adverseExcursionRecoverySeconds must be an integer 1-15");
  }
  if (c["rapidMoveLookbackSeconds"] != null) {
    const v = Number(c["rapidMoveLookbackSeconds"]);
    if (!Number.isInteger(v) || v < 1 || v > 15) errors.push("rapidMoveLookbackSeconds must be an integer 1-15");
  }
  if (c["rapidMoveThresholdPct"] != null) {
    const v = Number(c["rapidMoveThresholdPct"]);
    if (!Number.isFinite(v) || v <= 0 || v > 10) errors.push("rapidMoveThresholdPct must be > 0 and ≤ 10");
  }
  if (c["targetProximityThresholdPct"] != null) {
    const v = Number(c["targetProximityThresholdPct"]);
    if (!Number.isFinite(v) || v <= 0 || v > 10) {
      errors.push("targetProximityThresholdPct must be > 0 and ≤ 10");
    }
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

/**
 * Convert the server-owned breaker reason code into operator-facing language.
 * Never expose raw machine strings in the dashboard; unknown legacy values get
 * a safe generic explanation instead.
 */
export function describeScalpCircuitBreakerReason(reason: string | null): string {
  if (!reason) {
    return "The Scalper recorded a safety event, but no additional details were available.";
  }

  if (reason === "submitting_order_found_after_restart") {
    return "The Scalper restarted while a live order was still being submitted, so it could not confirm whether that order filled.";
  }

  const outsideBand = reason.match(
    /^fill_outside_band:([^:]+):(yes|no):cost=([0-9.]+):band=\[([0-9.]+),([0-9.]+)\]$/,
  );
  if (outsideBand) {
    const [, symbol, side, costText, minText, maxText] = outsideBand;
    const cost = Number(costText) * 100;
    const min = Number(minText) * 100;
    const max = Number(maxText) * 100;
    const cents = (value: number): string =>
      `${value.toFixed(2).replace(/\.?0+$/, "")}¢`;
    return `${symbol} ${side.toUpperCase()} filled at ${cents(cost)}, outside your allowed ${cents(min)}–${cents(max)} range.`;
  }

  const aboveCeiling = reason.match(
    /^fill_above_ceiling:([^:]+):(yes|no):cost=([0-9.]+):ceiling=([0-9.]+)$/,
  );
  if (aboveCeiling) {
    const [, symbol, side, costText, maxText] = aboveCeiling;
    const cost = Number(costText) * 100;
    const max = Number(maxText) * 100;
    const cents = (value: number): string =>
      `${value.toFixed(2).replace(/\.?0+$/, "")}¢`;
    return `${symbol} ${side.toUpperCase()} filled at ${cents(cost)}, above your ${cents(max)} winning-cost ceiling.`;
  }

  if (reason.startsWith("scalp_submit_threw:")) {
    const symbol = reason.split(":")[1] || "live";
    return `Kalshi did not confirm whether the ${symbol} order was accepted or filled.`;
  }

  if (reason.startsWith("unknown_confirmed_exposure:")) {
    const symbol = reason.split(":")[1] || "live";
    return `Kalshi returned a ${symbol} order result the Scalper could not verify. The order may or may not have filled.`;
  }

  if (reason.startsWith("unverified_exchange_response:")) {
    const symbol = reason.split(":")[1] || "live";
    return `Kalshi returned a ${symbol} order result the Scalper could not verify. The order may or may not have filled.`;
  }

  if (reason.startsWith("post_submit_persist_failed:")) {
    const symbol = reason.split(":")[2] || "live";
    return `The ${symbol} order reached Kalshi, but the Scalper could not safely save its final result.`;
  }

  return "The Scalper detected a live-order safety problem that it could not verify automatically. Review recent incidents before continuing.";
}

/**
 * A breaker event that happens during an async config write must win over the
 * write's stale proposed latch fields. When the version is unchanged, explicit
 * reset behavior is preserved.
 */
export function preserveNewerScalpBreakerState<T extends {
  circuitBreaker: boolean;
  circuitBreakerReason: string | null;
}>(
  proposed: T,
  latest: Pick<T, "circuitBreaker" | "circuitBreakerReason">,
  versionAtStart: number,
  latestVersion: number,
): T {
  if (latestVersion === versionAtStart) return proposed;
  return {
    ...proposed,
    circuitBreaker: latest.circuitBreaker,
    circuitBreakerReason: latest.circuitBreakerReason,
  };
}

/**
 * Apply the breaker persistence failure policy. Normal safety events retain an
 * in-memory latch and retry in the background; callers that are about to
 * release uncertain live exposure must require durable persistence and abort
 * when it fails.
 */
export async function persistCircuitBreakerWithPolicy(
  persist: () => Promise<unknown>,
  onFailure: (error: unknown) => void,
  requireDurable: boolean,
): Promise<void> {
  try {
    await persist();
  } catch (error) {
    onFailure(error);
    if (requireDurable) throw error;
  }
}

/** Operator-settable fields only. Internal breaker state fields are NOT allowed. */
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
  openCapDollars?: number;
  freefallGuardEnabled?: boolean;
  freefallConsecutiveSeconds?: number;
  favorableTrendConfirmationEnabled?: boolean;
  coordinatedDirectionClearanceEnabled?: boolean;
  freefallLookbackSeconds?: number;
  freefallThresholdPct?: number;
  adverseExcursionGuardEnabled?: boolean;
  adverseExcursionLookbackSeconds?: number;
  adverseExcursionThresholdPct?: number;
  adverseExcursionRecoverySeconds?: number;
  rapidMoveGuardEnabled?: boolean;
  rapidMoveLookbackSeconds?: number;
  rapidMoveThresholdPct?: number;
  targetProximityGuardEnabled?: boolean;
  targetProximityThresholdPct?: number;
  circuitBreakerEnabled?: boolean;
  perMarketOverrides?: ScalpPerMarketOverridePatch[];
}

export type ParseScalpConfigResult =
  | { ok: true; value: ScalpConfigPatch }
  | { ok: false; errors: string[] };

// Allowlist of top-level operator fields. The enforcement toggle is operator
// owned; latched circuitBreaker / circuitBreakerReason remain server-owned and
// reset only via the dedicated route.
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
  "freefallConsecutiveSeconds",
  "favorableTrendConfirmationEnabled",
  "coordinatedDirectionClearanceEnabled",
  "freefallLookbackSeconds",
  "freefallThresholdPct",
  "adverseExcursionGuardEnabled",
  "adverseExcursionLookbackSeconds",
  "adverseExcursionThresholdPct",
  "adverseExcursionRecoverySeconds",
  "rapidMoveGuardEnabled",
  "rapidMoveLookbackSeconds",
  "rapidMoveThresholdPct",
  "targetProximityGuardEnabled",
  "targetProximityThresholdPct",
  "circuitBreakerEnabled",
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
 *   - enabled / freefallGuardEnabled / circuitBreakerEnabled that are not booleans
 *   - mode that is not exactly "paper" | "live"
 *   - numeric fields that are not finite JSON numbers, or out of range
 *   - a daily cap that is anything other than number | null
 *   - an open cap that is not a positive finite number at or below $50
 *   - perMarketOverrides that are not a well-formed array of allowlisted objects,
 *     with normalized/supported uppercase symbols, real booleans, and
 *     number|null numeric overrides; unknown keys / duplicate symbols rejected
 *
 * Explicit null is preserved for nullable daily cap and override numerics to
 * keep "clear this value" semantics distinct from "leave unchanged" (absent).
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
  if (has("adverseExcursionGuardEnabled")) {
    if (typeof body["adverseExcursionGuardEnabled"] !== "boolean") errors.push("adverseExcursionGuardEnabled must be a boolean");
    else out.adverseExcursionGuardEnabled = body["adverseExcursionGuardEnabled"];
  }
  if (has("favorableTrendConfirmationEnabled")) {
    if (typeof body["favorableTrendConfirmationEnabled"] !== "boolean") {
      errors.push("favorableTrendConfirmationEnabled must be a boolean");
    } else {
      out.favorableTrendConfirmationEnabled = body["favorableTrendConfirmationEnabled"];
    }
  }
  if (has("coordinatedDirectionClearanceEnabled")) {
    if (typeof body["coordinatedDirectionClearanceEnabled"] !== "boolean") {
      errors.push("coordinatedDirectionClearanceEnabled must be a boolean");
    } else {
      out.coordinatedDirectionClearanceEnabled =
        body["coordinatedDirectionClearanceEnabled"];
    }
  }
  if (has("rapidMoveGuardEnabled")) {
    if (typeof body["rapidMoveGuardEnabled"] !== "boolean") errors.push("rapidMoveGuardEnabled must be a boolean");
    else out.rapidMoveGuardEnabled = body["rapidMoveGuardEnabled"];
  }
  if (has("targetProximityGuardEnabled")) {
    if (typeof body["targetProximityGuardEnabled"] !== "boolean") errors.push("targetProximityGuardEnabled must be a boolean");
    else out.targetProximityGuardEnabled = body["targetProximityGuardEnabled"];
  }
  if (has("circuitBreakerEnabled")) {
    if (typeof body["circuitBreakerEnabled"] !== "boolean") errors.push("circuitBreakerEnabled must be a boolean");
    else out.circuitBreakerEnabled = body["circuitBreakerEnabled"];
  }

  // ── mode (exact string) ──
  if (has("mode")) {
    if (body["mode"] !== "paper" && body["mode"] !== "live") errors.push("mode must be exactly 'paper' or 'live'");
    else out.mode = body["mode"];
  }

  // ── Numeric fields (real finite numbers, in range) ──
  const numField = (
    key: "globalBandMin" | "globalBandMax" | "finalWindowSeconds" | "budgetDollars" | "freefallConsecutiveSeconds" | "freefallLookbackSeconds" | "freefallThresholdPct" | "adverseExcursionLookbackSeconds" | "adverseExcursionThresholdPct" | "adverseExcursionRecoverySeconds" | "rapidMoveLookbackSeconds" | "rapidMoveThresholdPct" | "targetProximityThresholdPct",
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
  numField("freefallConsecutiveSeconds", (v) => Number.isInteger(v) && v >= 1 && v <= 15, "freefallConsecutiveSeconds must be an integer 1-15");
  numField("freefallLookbackSeconds", (v) => v >= 1 && v <= 600, "freefallLookbackSeconds must be a number 1-600");
  numField("freefallThresholdPct", (v) => v > 0, "freefallThresholdPct must be a number > 0");
  numField("adverseExcursionLookbackSeconds", (v) => Number.isInteger(v) && v >= 5 && v <= 60, "adverseExcursionLookbackSeconds must be an integer 5-60");
  numField("adverseExcursionThresholdPct", (v) => v > 0 && v <= 10, "adverseExcursionThresholdPct must be a number > 0 and ≤ 10");
  numField("adverseExcursionRecoverySeconds", (v) => Number.isInteger(v) && v >= 1 && v <= 15, "adverseExcursionRecoverySeconds must be an integer 1-15");
  numField("rapidMoveLookbackSeconds", (v) => Number.isInteger(v) && v >= 1 && v <= 15, "rapidMoveLookbackSeconds must be an integer 1-15");
  numField("rapidMoveThresholdPct", (v) => v > 0 && v <= 10, "rapidMoveThresholdPct must be a number > 0 and ≤ 10");
  numField("targetProximityThresholdPct", (v) => v > 0 && v <= 10, "targetProximityThresholdPct must be a number > 0 and ≤ 10");

  // ── Caps ──
  if (has("dailyCapDollars")) {
    const v = body["dailyCapDollars"];
    if (v === null) out.dailyCapDollars = null;
    else if (!isFiniteNumber(v) || v <= 0) errors.push("dailyCapDollars must be a number > 0 or null");
    else out.dailyCapDollars = v;
  }
  if (has("openCapDollars")) {
    const v = body["openCapDollars"];
    if (!isFiniteNumber(v) || v <= 0) {
      errors.push("openCapDollars must be a finite number > 0");
    } else {
      out.openCapDollars = v;
    }
  }

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
