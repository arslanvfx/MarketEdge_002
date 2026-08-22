// ---------------------------------------------------------------------------
// kalshi-scalper-types.ts — Pure type definitions for the isolated scalper.
// No imports from regular bot state, no side-effects.
// ---------------------------------------------------------------------------

export type ScalpMode = "paper" | "live";

export interface ScalpPerMarketOverride {
  symbol: string;
  paused?: boolean;
  minBand?: number;       // override global min (0-1), direct contract cost
  maxBand?: number;       // override global max (0-1), direct contract cost
  windowSeconds?: number; // override final-window seconds
  budgetDollars?: number; // override per-order budget
}

export interface ScalpConfig {
  enabled: boolean;
  mode: ScalpMode;
  /** Direct winning-contract cost band — both YES ask and NO ask are checked directly.
   *  Default 0.91–0.98 (select contracts priced 91¢–98¢ per $1 payout). */
  globalBandMin: number;
  globalBandMax: number;
  finalWindowSeconds: number;   // default 120
  budgetDollars: number;        // per-order budget, default $2
  dailyCapDollars: number | null;
  openCapDollars: number | null;
  freefallGuardEnabled: boolean;    // default true
  freefallLookbackSeconds: number;
  freefallThresholdPct: number;     // % adverse underlying move that blocks entry
  /** Block entries when the fresh underlying is within this percentage of the
   *  force-refreshed Kalshi target. Independent of the contract-price band. */
  targetProximityGuardEnabled: boolean;
  targetProximityThresholdPct: number;
  /** Operator control for whether a latched breaker halts new attempts.
   *  Trigger state/reason are always recorded even when enforcement is off. */
  circuitBreakerEnabled: boolean;
  circuitBreaker: boolean;
  circuitBreakerReason: string | null; // why the breaker tripped
  perMarketOverrides: ScalpPerMarketOverride[];
}

export const DEFAULT_SCALP_CONFIG: ScalpConfig = {
  enabled: false,
  mode: "paper",
  globalBandMin: 0.91,
  globalBandMax: 0.98,
  finalWindowSeconds: 120,
  budgetDollars: 2,
  dailyCapDollars: null,
  openCapDollars: null,
  freefallGuardEnabled: true,
  freefallLookbackSeconds: 30,
  freefallThresholdPct: 0.5,
  targetProximityGuardEnabled: true,
  targetProximityThresholdPct: 0.05,
  circuitBreakerEnabled: true,
  circuitBreaker: false,
  circuitBreakerReason: null,
  perMarketOverrides: [],
};

// Effective params for a single symbol (global + per-market merged)
export interface EffectiveScalpParams {
  symbol: string;
  ticker: string;
  paused: boolean;
  bandMin: number;
  bandMax: number;
  finalWindowSeconds: number;
  budgetDollars: number;
}

// ---------------------------------------------------------------------------
// Quote types
// ---------------------------------------------------------------------------

/** A validated two-sided authenticated quote. Derived exclusively from
 *  fetchOrderbookPrices: yesBid/yesAsk are the YES-side book prices.
 *  noAsk is derived as 1 - yesBid (what it costs to buy a NO contract). */
export interface ValidatedQuote {
  ticker: string;
  yesAsk: number;  // cost to buy YES (fraction 0-1)
  yesBid: number;  // best YES bid (fraction 0-1)
  noAsk: number;   // cost to buy NO = 1 - yesBid
  closeTime: string;
}

// ---------------------------------------------------------------------------
// Reservation
// ---------------------------------------------------------------------------
// (ScalpReservation is defined after ScalpSkipEvidence near the bottom of this
//  file so it can reference that type. See "Reservation skip_evidence field".)

// ---------------------------------------------------------------------------
// Order
// ---------------------------------------------------------------------------

/** order_status tracks the durable lifecycle of the order attempt. */
export type ScalpOrderStatus =
  | "submitting"   // intent recorded; live placeOrder in flight
  | "filled"       // confirmed filledCount > 0 from exchange response
  | "zero_fill"    // IOC returned 0 fills
  | "error"        // pre-order failure (never reached exchange)
  | "unknown"      // live placeOrder threw / crash mid-flight — fill state indeterminate
  | "paper"        // paper simulation complete
  | "skipped";     // pre-order guard rejected; never reached exchange

export interface ScalpOrder {
  id: string;
  mode: ScalpMode;
  symbol: string;
  windowKey: string;
  ticker: string;
  side: "yes" | "no";
  /** YES-side authoritative quote observed immediately before submission. */
  entryYesPrice: number;
  contractCount: number;
  /** Actual $ cost spent = winningContractCost * filledCount */
  budgetSpent: number;
  /** Caller-generated idempotency/reconciliation key persisted before live POST. */
  clientOrderId: string | null;
  orderId: string | null;
  /** Exact strict-parser/transport reason retained for future reconciliation. */
  exchangeResponseReason: string | null;
  filledCount: number;
  /** avgFillPrice is always the YES-side fraction as returned by placeOrder. */
  avgFillPrice: number | null;
  /** YES-side limit price passed to placeOrder */
  limitPrice: number;
  /** Winning-contract cost at fill time: yesAsk for YES, 1-avgFillPrice for NO */
  winningContractCost: number | null;
  status: ScalpOrderStatus;
  errorMessage: string | null;
  settlementResult: "yes" | "no" | null;
  outcome: "win" | "loss" | null;
  pnl: number | null;
  incidentId: string | null;
  reconciledAt: Date | null;
  reconciliationEvidence: Record<string, unknown> | null;
  createdAt: Date;
  settledAt: Date | null;
}

// ---------------------------------------------------------------------------
// Incident
// ---------------------------------------------------------------------------

export interface ScalpIncident {
  id: string;
  orderId: string | null;
  mode: ScalpMode;
  symbol: string;
  windowKey: string;
  ticker: string;
  severity: "high";
  description: string;
  expectedBandMin: number;
  expectedBandMax: number;
  actualWinningCost: number; // the winning-contract cost that triggered the incident
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// Performance
// ---------------------------------------------------------------------------

export interface ScalpPerformance {
  mode: ScalpMode;
  /** Inclusive order-entry boundary for this reporting window. */
  trackingSince: string;
  /** Monotonic per-mode reset generation used to reject stale responses. */
  trackingVersion: number;
  totalOrders: number;
  filledOrders: number;
  /** Aligned with frontend field name (was settledOrders). */
  settled: number;
  wins: number;
  losses: number;
  winRate: number | null;
  totalPnl: number;
  totalSpent: number;
  avgFillPrice: number | null;
  bySymbol: Array<{
    symbol: string;
    orders: number;
    wins: number;
    losses: number;
    settled: number;
    winRate: number | null;
    pnl: number;
    spent: number;
    avgFillPrice: number | null;
  }>;
}

// ---------------------------------------------------------------------------
// Skip evidence (structured, additive, durable — stored in skip_evidence JSONB)
// ---------------------------------------------------------------------------

/** Structured evidence persisted alongside a skipped reservation row.
 *  All fields are optional/nullable so older rows without evidence remain valid.
 *  Never contains credentials or raw exchange payloads. */
export interface ScalpSkipEvidence {
  // ── Timing / window phase ─────────────────────────────────────────────────
  /** Timing phase at skip time: preflight_warmup | waiting_eligibility | eligible | closed_expired */
  timingPhase?: "preflight_warmup" | "waiting_eligibility" | "eligible" | "closed_expired";
  /** Market close time (ISO) when the skip was evaluated. */
  closeTimeIso?: string;
  /** Seconds remaining until market close at skip time (null = unavailable). */
  secondsRemaining?: number | null;
  /** Effective window seconds configured for this symbol. */
  effectiveWindowSeconds?: number;
  /** UTC market window key tied to the reservation. */
  windowKey?: string;

  // ── Target distance ───────────────────────────────────────────────────────
  /** Absolute distance of live underlying price from Kalshi target as %. */
  distancePct?: number | null;
  /** Threshold % that would block the entry. */
  minimumPct?: number | null;
  /** Force-refreshed Kalshi target price. */
  targetPrice?: number | null;
  /** Live underlying price at skip time. */
  underlyingPrice?: number | null;

  // ── Freefall guard ────────────────────────────────────────────────────────
  /** Adverse move % that caused/failed the guard. */
  adverseMovePct?: number | null;
  /** Configured threshold % for the freefall guard. */
  freefallThresholdPct?: number | null;
  /** Number of price samples used in the freefall evaluation. */
  samplesUsed?: number | null;
  /** Observed coverage span (ms) of samples used. */
  sampleCoverageMs?: number | null;
  /** Which side was being protected (yes = falling blocks YES, no = rising blocks NO). */
  protectedSide?: "yes" | "no" | null;

  // ── Authenticated quote / identity ────────────────────────────────────────
  /** Machine reason code from the orderbook/quote validation step. */
  quotedReason?: string | null;
  /** Machine reason code from the identity check (ticker/closeTime match). */
  identityReason?: string | null;
  /** Whether the quote fetch succeeded (false = network error, null = not attempted). */
  quoteFetchOk?: boolean | null;
  /** Whether the identity refresh succeeded. */
  identityFetchOk?: boolean | null;
  /** Authenticated YES ask observed at the final decision boundary. */
  quoteYesAsk?: number | null;
  /** Authenticated NO ask observed at the final decision boundary. */
  quoteNoAsk?: number | null;
  /** Winning-side ask selected from the authenticated quote. */
  winningAsk?: number | null;
  /** Side selected from the authenticated quote. */
  selectedSide?: "yes" | "no" | null;
  /** Effective lower band bound used for the decision. */
  bandMin?: number | null;
  /** Effective upper band bound used for the decision. */
  bandMax?: number | null;
  /** Ticker pinned when the reservation was claimed. */
  reservedTicker?: string | null;
  /** Ticker returned by the final identity refresh. */
  refreshedTicker?: string | null;
  /** Close time returned by the final identity refresh. */
  refreshedCloseTimeIso?: string | null;

  // ── Latency / timing measurements ────────────────────────────────────────
  /** Elapsed ms from attempt start to skip decision (diagnostic only). */
  elapsedMs?: number | null;
  /** Duration of the force-refreshed market identity request. */
  identityRefreshMs?: number | null;
  /** Duration of the authenticated orderbook request. */
  quoteRefreshMs?: number | null;
  /** Wall time for all concurrent final refreshes. */
  parallelRefreshMs?: number | null;
  /** ISO timestamp when the skip was recorded. */
  skippedAt?: string;

  // ── Cap, sizing, and balance context ──────────────────────────────────────
  requestedBudget?: number | null;
  dailyCapDollars?: number | null;
  openCapDollars?: number | null;
  dailyCommittedDollars?: number | null;
  openCommittedDollars?: number | null;
  availableBalance?: number | null;
  maxExposure?: number | null;
}

// ---------------------------------------------------------------------------
// Status market row
// ---------------------------------------------------------------------------

/** Timing phase for a scalp market candidate — disambiguates the UI states. */
export type ScalpTimingPhase =
  | "preflight_warmup"    // non-submitting warm-up inside the configured preflight lead
  | "waiting_eligibility" // not yet inside the preflight lead or close time unavailable
  | "eligible"            // within finalWindowSeconds of close — active submission window
  | "closed_expired";     // market close already passed

/** Market status row — field names aligned exactly with the frontend
 *  ScalperStatusMarket interface. `state` uses 'active' when the market is a
 *  live in-window candidate. `lastAsk` is the selected winning-contract ask
 *  (yesAsk for YES-in-band, noAsk for NO-in-band) or null. */
export interface ScalpMarketStatus {
  symbol: string;
  state: "active" | "guarded" | "ready" | "out_of_band" | "paused" | "no_quote";
  /** Timing phase — frontend uses this to distinguish preflight warm-up,
   *  waiting for eligibility, eligible final window, and closed/expired. */
  timingPhase: ScalpTimingPhase;
  effectiveBandMin: number;
  effectiveBandMax: number;
  effectiveWindowSeconds: number;
  effectiveBudgetDollars: number;
  lastAsk: number | null;
  secondsRemaining: number | null;
  /** Seconds until the eligibility window opens (null when already eligible or no close time). */
  secondsUntilEligible: number | null;
  freefallBlocked: boolean;
  targetProximityBlocked: boolean;
  targetDistancePct: number | null;
  reason: string | null;
}

// ---------------------------------------------------------------------------
// Reservation skip_evidence field
// ---------------------------------------------------------------------------

/** Updated ScalpReservation shape including optional structured skip evidence. */
export interface ScalpReservation {
  id: string;
  mode: ScalpMode;
  symbol: string;
  windowKey: string;
  ticker: string;
  createdAt: Date;
  attemptedAt: Date;
  status: "claimed" | "filled" | "zero_fill" | "error" | "skipped" | "unknown";
  reason?: string;
  /** Budget reserved for cap accounting until the attempt resolves. */
  reservedBudget: number;
  /** Durable count of live IOC submissions for this symbol/window. */
  submissionCount: number;
  /** Latest confirmed live outcome side, or simulated paper side. */
  latestSide?: "yes" | "no";
  /** Authoritative winning-contract quote for that submission/simulation. */
  observedWinningAsk?: number;
  /** Worst winning-contract cost for that proven submission/simulation. */
  executionWinningLimit?: number;
  /** Raw YES-side limit from a confirmed live outcome (live only). */
  submittedLimitPrice?: number;
  /** Structured skip evidence (null for non-skip rows and pre-upgrade rows). */
  skipEvidence?: ScalpSkipEvidence | null;
}
