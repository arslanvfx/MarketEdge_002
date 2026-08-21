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
}

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
  /** YES-side price we used when computing count (= winningAsk for YES, 1-winningAsk for NO) */
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
// Status market row
// ---------------------------------------------------------------------------

/** Market status row — field names aligned exactly with the frontend
 *  ScalperStatusMarket interface. `state` uses 'active' when the market is a
 *  live in-window candidate. `lastAsk` is the selected winning-contract ask
 *  (yesAsk for YES-in-band, noAsk for NO-in-band) or null. */
export interface ScalpMarketStatus {
  symbol: string;
  state: "active" | "ready" | "out_of_band" | "paused" | "no_quote";
  effectiveBandMin: number;
  effectiveBandMax: number;
  effectiveWindowSeconds: number;
  effectiveBudgetDollars: number;
  lastAsk: number | null;
  secondsRemaining: number | null;
  freefallBlocked: boolean;
  reason: string | null;
}
