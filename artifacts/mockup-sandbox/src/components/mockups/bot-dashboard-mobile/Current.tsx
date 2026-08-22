import './_group.css';
import { useState } from "react";
import {
  Zap, Pause, Target, Activity, AlertTriangle,
  Shield, CheckCircle2, Settings2, RotateCcw,
} from "lucide-react";

// ─────────────────────────────────────────────────────────────────────────────
// Extracted from artifacts/market-edge/src/pages/bot/bot-scalper-panel.tsx
// (the BotScalperPanel settings area). Auth (@clerk/react), React Query, and the
// authPost API client are all stubbed with realistic static data. All utility
// helpers (utils.ts) and ledger describe helpers (scalper-ledger.ts) are inlined.
// Visual output preserved 1:1 with the original component.
// ─────────────────────────────────────────────────────────────────────────────

// ── Inlined type shapes (subset used by this component) ──────────────────────
interface ScalperConfig {
  enabled: boolean;
  mode: "paper" | "live";
  globalBandMin: number;
  globalBandMax: number;
  finalWindowSeconds: number;
  budgetDollars: number;
  dailyCapDollars: number | null;
  openCapDollars: number;
  freefallGuardEnabled: boolean;
  freefallLookbackSeconds: number;
  freefallThresholdPct: number;
  targetProximityGuardEnabled: boolean;
  targetProximityThresholdPct: number;
  circuitBreakerEnabled: boolean;
  circuitBreaker: boolean;
  circuitBreakerReason: string | null;
  perMarketOverrides: Array<{
    symbol: string;
    paused?: boolean;
    minBand?: number | null;
    maxBand?: number | null;
    windowSeconds?: number | null;
    budgetDollars?: number | null;
  }>;
}

type ScalpTimingPhase =
  | "preflight_warmup" | "waiting_eligibility" | "eligible" | "closed_expired";

interface ScalperStatusMarket {
  symbol: string;
  state: string;
  timingPhase: ScalpTimingPhase;
  effectiveBandMin: number;
  effectiveBandMax: number;
  effectiveWindowSeconds: number;
  effectiveBudgetDollars: number;
  lastAsk: number | null;
  secondsRemaining: number | null;
  secondsUntilEligible: number | null;
  freefallBlocked: boolean;
  targetProximityBlocked: boolean;
  targetDistancePct: number | null;
  reason: string | null;
}

interface ScalperAttempt {
  id: string;
  mode: "paper" | "live";
  symbol: string;
  windowKey: string;
  ticker: string;
  status: "claimed" | "filled" | "zero_fill" | "error" | "skipped" | "unknown";
  reason: string | null;
  reservedBudget: number;
  submissionCount: number;
  side: "yes" | "no" | null;
  observedWinningAsk: number | null;
  executionWinningLimit: number | null;
  submittedLimitPrice: number | null;
  skipEvidence: any | null;
  latency?: {
    totalMs: number;
    slowestStage: string | null;
    slowestStageMs: number | null;
  } | null;
  retryEligible: boolean;
  retryState: "ready" | "cooldown" | "in_flight" | "terminal";
  retryAfterMs: number | null;
  createdAt: string;
  attemptedAt: string;
}

interface ScalperStatus {
  config: ScalperConfig;
  circuitBreaker: boolean;
  circuitBreakerReason: string | null;
  circuitBreakerMessage: string;
  mode: "paper" | "live";
  totalReservationsToday: number;
  openSpend: number;
  dailySpend: number;
  recentAttempts: ScalperAttempt[];
  latency: { sampleSize: number; p50Ms: number | null; p90Ms: number | null; p99Ms: number | null; maxMs: number | null };
  lastScanAt: string | null;
  lastError: string | null;
  preflight: {
    state: "idle" | "warming" | "ready" | "blocked";
    mode: "paper" | "live";
    windowKey: string | null;
    checkedAt: string | null;
    startsInSeconds: number | null;
    readySymbols: number;
    totalSymbols: number;
    reason: string | null;
    markets: Array<{ symbol: string; ready: boolean; reason: string | null }>;
  };
  executionPolicy: {
    scanIntervalMs: number;
    maxSubmissionsPerWindow: number;
    preflightLeadSeconds: number;
  };
  markets: ScalperStatusMarket[];
  unresolvedAttempts?: any[];
}

interface ScalperPerformanceBySymbol {
  symbol: string; orders: number; settled: number; wins: number; losses: number;
  winRate: number | null; pnl: number; spent: number; avgFillPrice: number | null;
}

interface ScalperPerformance {
  mode: "paper" | "live";
  trackingSince: string;
  totalOrders: number;
  filledOrders: number;
  settled: number;
  wins: number;
  losses: number;
  winRate: number | null;
  totalPnl: number;
  totalSpent: number;
  avgFillPrice: number | null;
  bySymbol: ScalperPerformanceBySymbol[];
}

const PER_MARKET_SYMBOLS = ["BTC", "ETH", "XRP", "HYPE", "BNB", "SOL", "DOGE", "NEAR", "ZEC", "GOLD", "SILVER", "WTI"];

// ── Inlined helpers from utils.ts ────────────────────────────────────────────
const EST = "America/New_York";

function getEtUtcOffset(): number {
  const now = new Date();
  const year = now.getUTCFullYear();
  const marchFirst = new Date(Date.UTC(year, 2, 1));
  const dstStart = new Date(Date.UTC(year, 2, 8 + (7 - marchFirst.getUTCDay()) % 7, 7));
  const novFirst = new Date(Date.UTC(year, 10, 1));
  const dstEnd = new Date(Date.UTC(year, 10, (7 - novFirst.getUTCDay()) % 7 + 1, 6));
  return now >= dstStart && now < dstEnd ? 4 : 5;
}
const ET_OFFSET = getEtUtcOffset();
const ET_LABEL = ET_OFFSET === 4 ? "EDT" : "EST";

const fmt$ = (n: number | string | null | undefined, decimals = 2) => {
  if (n == null || n === "") return "—";
  const v = typeof n === "string" ? parseFloat(n) : n;
  return isNaN(v) ? "—" : `$${v.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
};

const fmtDateTime = (iso: string | null) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: EST }) + " " +
    d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: EST }) + " EST";
};

const wkToEstRange = (wk: string | null | undefined): string => {
  if (!wk) return "—";
  const start = new Date(wk + ":00Z");
  const end = new Date(start.getTime() + 15 * 60_000);
  const fmtNoAmPm = (d: Date) =>
    d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: EST }).replace(/\s?[AP]M$/i, "");
  const fmtFull = (d: Date) =>
    d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: EST });
  return `${fmtNoAmPm(start)} – ${fmtFull(end)}`;
};

// ── Inlined helpers from scalper-ledger.ts ───────────────────────────────────
const REASON_LABELS: Record<string, string> = {
  outside_window_at_claim: "Outside the effective entry window at reservation",
  window_expired_before_submit: "Window expired before final checks",
  outside_window_before_submit: "Outside the effective entry window before submission",
  outside_window_second_quote: "Window expired while refreshing the final quote",
  identity_outside_window: "Refreshed market identity was outside the entry window",
  identity_refresh_failed: "Final market identity refresh failed",
  identity_missing_after_refresh: "Final market identity was unavailable",
  identity_changed: "Kalshi market identity changed during final checks",
  identity_changed_before_submit: "Kalshi market identity changed before submission",
  identity_missing_before_submit: "Kalshi market identity was missing before submission",
  final_quote_invalid: "Authenticated final quote was unavailable or invalid",
  final_quote_outside_band: "Authenticated final quote moved outside the permitted band",
  side_flipped_final_quote: "Authenticated final quote changed the qualifying side",
  target_proximity_too_close: "Underlying price was too close to the Kalshi target",
  target_proximity_unavailable_no_product: "Target-distance data was unavailable",
  target_proximity_unavailable_fetch_failed: "Fresh underlying price was unavailable for target-distance validation",
  freefall_adverse_falling: "Adverse downward move exceeded the Freefall limit",
  freefall_adverse_rising: "Adverse upward move exceeded the Freefall limit",
  freefall_adverse_reversal_falling: "A sharp downward reversal exceeded the Freefall limit",
  freefall_adverse_reversal_rising: "A sharp upward reversal exceeded the Freefall limit",
  freefall_unavailable_no_samples: "Freefall guard lacked enough fresh samples",
  freefall_unavailable_coverage: "Freefall samples did not cover enough of the lookback",
  freefall_unavailable_stale: "Freefall samples were stale",
  freefall_unavailable_fetch_failed: "Fresh underlying price fetch failed — Freefall blocked submission",
  freefall_unavailable_no_product: "Underlying product was unavailable — Freefall blocked submission",
  freefall_unavailable_out_of_order: "Freefall samples arrived out of order",
  final_balance_check_failed: "Final balance check failed",
  balance_check_failed_final: "Final balance check failed",
  insufficient_balance_final: "Available balance was below worst-case exposure",
  breaker_before_submit: "Circuit breaker blocked submission",
};

function humanizeReason(reason: string): string {
  const clean = reason.replace(/^aborted_before_submit:/, "").replace(/\s*\([^)]*\)\s*$/, "");
  return REASON_LABELS[clean] ?? clean
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatUnderlyingPrice(value: number): string {
  return `$${value.toLocaleString(undefined, { maximumFractionDigits: value < 10 ? 5 : 2 })}`;
}

function formatMoney(value: number | null | undefined): string {
  return value == null ? "unavailable" : `$${value.toFixed(2)}`;
}

function formatLatency(value: number | null | undefined): string {
  if (value == null) return "unavailable";
  if (value < 1_000) return `${Math.round(value)}ms`;
  return `${(value / 1_000).toFixed(value < 10_000 ? 2 : 1)}s`;
}

function describeScalperAttempt(attempt: ScalperAttempt): string {
  if (attempt.status === "filled") return "Confirmed fill";
  if (attempt.status === "zero_fill") return "IOC returned zero fills";
  if (attempt.status === "unknown") return "Order result unknown — reconciliation required";
  if (attempt.status === "error") return attempt.reason ? `Error — ${humanizeReason(attempt.reason)}` : "Attempt failed";
  if (attempt.reason === "second_quote_outside_band" || attempt.reason === "final_quote_outside_band") {
    return "Final authenticated quote moved outside the permitted band";
  }
  if (attempt.reason === "first_quote_outside_band") return "Preliminary quote was outside the band";
  if (attempt.status === "claimed") return "Checks in progress";
  return attempt.reason ? humanizeReason(attempt.reason) : "Skipped before order";
}

function describeScalperEvidence(attempt: ScalperAttempt): string[] {
  const evidence = attempt.skipEvidence;
  const details: string[] = [];

  if (evidence && (evidence.distancePct != null || evidence.minimumPct != null)) {
    const measured = evidence.distancePct == null ? "unavailable" : `${evidence.distancePct.toFixed(3)}%`;
    const minimum = evidence.minimumPct == null ? "not configured" : `${evidence.minimumPct.toFixed(3)}% minimum`;
    const prices = evidence.targetPrice != null && evidence.underlyingPrice != null
      ? ` · target ${formatUnderlyingPrice(evidence.targetPrice)}, underlying ${formatUnderlyingPrice(evidence.underlyingPrice)}`
      : "";
    details.push(`Target distance ${measured} (${minimum})${prices}`);
  }

  if (evidence && (
    evidence.adverseMovePct != null || evidence.freefallThresholdPct != null || evidence.samplesUsed != null
  )) {
    const adverse = evidence.adverseMovePct == null ? "unavailable" : `${evidence.adverseMovePct.toFixed(3)}%`;
    const threshold = evidence.freefallThresholdPct == null
      ? "threshold unavailable"
      : `${evidence.freefallThresholdPct.toFixed(3)}% threshold`;
    const sampleText = evidence.samplesUsed == null
      ? ""
      : ` · ${evidence.samplesUsed} sample${evidence.samplesUsed === 1 ? "" : "s"}${
          evidence.sampleCoverageMs == null ? "" : ` over ${(evidence.sampleCoverageMs / 1_000).toFixed(1)}s`
        }`;
    const sideText = evidence.protectedSide ? ` · protected ${evidence.protectedSide.toUpperCase()}` : "";
    details.push(`Adverse move ${adverse} (${threshold})${sampleText}${sideText}`);
  }

  if (evidence && (evidence.quoteYesAsk != null || evidence.quoteNoAsk != null)) {
    const asks = [
      evidence.quoteYesAsk == null ? null : `YES ${(evidence.quoteYesAsk * 100).toFixed(1)}¢`,
      evidence.quoteNoAsk == null ? null : `NO ${(evidence.quoteNoAsk * 100).toFixed(1)}¢`,
    ].filter(Boolean).join(" / ");
    const band = evidence.bandMin != null && evidence.bandMax != null
      ? ` · permitted winning cost ${(evidence.bandMin * 100).toFixed(1)}–${(evidence.bandMax * 100).toFixed(1)}¢`
      : "";
    details.push(`Authenticated final quote ${asks}${band}`);
  }

  if (evidence?.requestedBudget != null) {
    const capDetails = [
      evidence.openCapDollars == null ? null : `open ${formatMoney(evidence.openCommittedDollars)} of ${formatMoney(evidence.openCapDollars)}`,
      evidence.dailyCapDollars == null ? null : `daily ${formatMoney(evidence.dailyCommittedDollars)} of ${formatMoney(evidence.dailyCapDollars)}`,
    ].filter(Boolean).join(" · ");
    details.push(`Requested ${formatMoney(evidence.requestedBudget)} · ${capDetails || "cap details unavailable"}`);
  }

  if (evidence && (evidence.availableBalance != null || evidence.maxExposure != null)) {
    details.push(`Available balance ${formatMoney(evidence.availableBalance)} · required exposure ${formatMoney(evidence.maxExposure)}`);
  }

  if (evidence && (evidence.secondsRemaining != null || evidence.effectiveWindowSeconds != null)) {
    const remaining = evidence.secondsRemaining == null
      ? "close time unavailable"
      : evidence.secondsRemaining > 0
        ? `${Math.max(0, evidence.secondsRemaining).toFixed(1)}s remained`
        : `closed ${Math.abs(evidence.secondsRemaining).toFixed(1)}s earlier`;
    const window = evidence.effectiveWindowSeconds == null ? "" : ` · ${evidence.effectiveWindowSeconds}s effective entry window`;
    details.push(`${remaining}${window}`);
  }

  const refreshLatencyParts = [
    evidence?.identityRefreshMs == null ? null : `identity ${evidence.identityRefreshMs}ms`,
    evidence?.quoteRefreshMs == null ? null : `quote ${evidence.quoteRefreshMs}ms`,
    evidence?.parallelRefreshMs == null ? null : `parallel total ${evidence.parallelRefreshMs}ms`,
  ].filter(Boolean);
  if (refreshLatencyParts.length > 0) {
    details.push(`Final refresh latency: ${refreshLatencyParts.join(" · ")}`);
  }

  if (attempt.latency) {
    const slowest = attempt.latency.slowestStage == null
      ? "stage unavailable"
      : `${attempt.latency.slowestStage.replaceAll("_", " ")} ${formatLatency(attempt.latency.slowestStageMs)}`;
    details.push(`Fast path ${formatLatency(attempt.latency.totalMs)} total · slowest ${slowest}`);
  }

  return details;
}

function formatScalperLatency(value: number | null): string {
  if (value == null) return "—";
  if (value < 1_000) return `${Math.round(value)}ms`;
  return `${(value / 1_000).toFixed(value < 10_000 ? 2 : 1)}s`;
}

// ── Static mock data (matches API response shapes) ───────────────────────────
const nowIso = new Date().toISOString();
const isoMinutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

const MOCK_CONFIG: ScalperConfig = {
  enabled: true,
  mode: "paper",
  globalBandMin: 0.55,
  globalBandMax: 0.85,
  finalWindowSeconds: 300,
  budgetDollars: 25,
  dailyCapDollars: 150,
  openCapDollars: 75,
  freefallGuardEnabled: true,
  freefallLookbackSeconds: 30,
  freefallThresholdPct: 0.35,
  targetProximityGuardEnabled: true,
  targetProximityThresholdPct: 0.25,
  circuitBreakerEnabled: true,
  circuitBreaker: false,
  circuitBreakerReason: null,
  perMarketOverrides: [
    { symbol: "BTC", minBand: 0.6, maxBand: 0.9, budgetDollars: 40 },
    { symbol: "ETH", budgetDollars: 30 },
    { symbol: "DOGE", paused: true },
    { symbol: "SOL", windowSeconds: 240 },
  ],
};

const MOCK_STATUS: ScalperStatus = {
  config: MOCK_CONFIG,
  circuitBreaker: false,
  circuitBreakerReason: null,
  circuitBreakerMessage: "",
  mode: "paper",
  totalReservationsToday: 14,
  openSpend: 52.5,
  dailySpend: 118.75,
  recentAttempts: [
    {
      id: "att-1", mode: "paper", symbol: "BTC", windowKey: "2024-06-10T18:45", ticker: "KXBTC-24JUN1018-B", status: "filled",
      reason: null, reservedBudget: 40, submissionCount: 1, side: "yes",
      observedWinningAsk: 0.68, executionWinningLimit: 0.69, submittedLimitPrice: 0.69,
      skipEvidence: null,
      latency: { totalMs: 412, slowestStage: "broker_submit", slowestStageMs: 180 },
      retryEligible: false, retryState: "terminal", retryAfterMs: null,
      createdAt: isoMinutesAgo(3), attemptedAt: isoMinutesAgo(3),
    },
    {
      id: "att-2", mode: "paper", symbol: "ETH", windowKey: "2024-06-10T18:45", ticker: "KXETH-24JUN1018-B", status: "zero_fill",
      reason: null, reservedBudget: 30, submissionCount: 2, side: "no",
      observedWinningAsk: 0.72, executionWinningLimit: 0.73, submittedLimitPrice: 0.73,
      skipEvidence: null, latency: null,
      retryEligible: true, retryState: "cooldown", retryAfterMs: 1800,
      createdAt: isoMinutesAgo(5), attemptedAt: isoMinutesAgo(5),
    },
    {
      id: "att-3", mode: "paper", symbol: "SOL", windowKey: "2024-06-10T18:30", ticker: "KXSOL-24JUN1018-B", status: "skipped",
      reason: "target_proximity_too_close", reservedBudget: 25, submissionCount: 0, side: "yes",
      observedWinningAsk: null, executionWinningLimit: null, submittedLimitPrice: null,
      skipEvidence: {
        distancePct: 0.12, minimumPct: 0.25, targetPrice: 148.5, underlyingPrice: 148.32,
        secondsRemaining: 84.2, effectiveWindowSeconds: 300,
      },
      latency: null, retryEligible: false, retryState: "terminal", retryAfterMs: null,
      createdAt: isoMinutesAgo(11), attemptedAt: isoMinutesAgo(11),
    },
    {
      id: "att-4", mode: "paper", symbol: "XRP", windowKey: "2024-06-10T18:30", ticker: "KXXRP-24JUN1018-B", status: "skipped",
      reason: "freefall_adverse_falling", reservedBudget: 25, submissionCount: 0, side: "no",
      observedWinningAsk: null, executionWinningLimit: null, submittedLimitPrice: null,
      skipEvidence: {
        adverseMovePct: 0.51, freefallThresholdPct: 0.35, samplesUsed: 18, sampleCoverageMs: 27400, protectedSide: "no",
        quoteYesAsk: 0.31, quoteNoAsk: 0.71, bandMin: 0.55, bandMax: 0.85,
      },
      latency: null, retryEligible: false, retryState: "terminal", retryAfterMs: null,
      createdAt: isoMinutesAgo(15), attemptedAt: isoMinutesAgo(15),
    },
    {
      id: "att-5", mode: "paper", symbol: "BNB", windowKey: "2024-06-10T18:15", ticker: "KXBNB-24JUN1018-B", status: "claimed",
      reason: null, reservedBudget: 25, submissionCount: 0, side: null,
      observedWinningAsk: null, executionWinningLimit: null, submittedLimitPrice: null,
      skipEvidence: null, latency: null,
      retryEligible: false, retryState: "in_flight", retryAfterMs: null,
      createdAt: isoMinutesAgo(20), attemptedAt: isoMinutesAgo(20),
    },
  ],
  latency: { sampleSize: 42, p50Ms: 318, p90Ms: 640, p99Ms: 1240, maxMs: 2100 },
  lastScanAt: nowIso,
  lastError: null,
  preflight: {
    state: "ready", mode: "paper", windowKey: "2024-06-10T18:45", checkedAt: isoMinutesAgo(1),
    startsInSeconds: null, readySymbols: 10, totalSymbols: 12, reason: null,
    markets: [
      { symbol: "ZEC", ready: false, reason: "no_open_market" },
      { symbol: "WTI", ready: false, reason: "underlying_unavailable" },
    ],
  },
  executionPolicy: { scanIntervalMs: 250, maxSubmissionsPerWindow: 3, preflightLeadSeconds: 90 },
  markets: [
    { symbol: "BTC", state: "active", timingPhase: "eligible", effectiveBandMin: 0.6, effectiveBandMax: 0.9, effectiveWindowSeconds: 300, effectiveBudgetDollars: 40, lastAsk: 0.67, secondsRemaining: 128, secondsUntilEligible: null, freefallBlocked: false, targetProximityBlocked: false, targetDistancePct: 0.88, reason: null },
    { symbol: "ETH", state: "active", timingPhase: "eligible", effectiveBandMin: 0.55, effectiveBandMax: 0.85, effectiveWindowSeconds: 300, effectiveBudgetDollars: 30, lastAsk: 0.71, secondsRemaining: 128, secondsUntilEligible: null, freefallBlocked: false, targetProximityBlocked: false, targetDistancePct: 1.42, reason: null },
    { symbol: "SOL", state: "guarded", timingPhase: "eligible", effectiveBandMin: 0.55, effectiveBandMax: 0.85, effectiveWindowSeconds: 240, effectiveBudgetDollars: 25, lastAsk: null, secondsRemaining: 68, secondsUntilEligible: null, freefallBlocked: false, targetProximityBlocked: true, targetDistancePct: 0.12, reason: "target_proximity_too_close" },
    { symbol: "XRP", state: "guarded", timingPhase: "eligible", effectiveBandMin: 0.55, effectiveBandMax: 0.85, effectiveWindowSeconds: 300, effectiveBudgetDollars: 25, lastAsk: null, secondsRemaining: 128, secondsUntilEligible: null, freefallBlocked: true, targetProximityBlocked: false, targetDistancePct: 2.1, reason: "freefall_adverse_falling" },
    { symbol: "HYPE", state: "waiting", timingPhase: "waiting_eligibility", effectiveBandMin: 0.55, effectiveBandMax: 0.85, effectiveWindowSeconds: 300, effectiveBudgetDollars: 25, lastAsk: null, secondsRemaining: null, secondsUntilEligible: 45, freefallBlocked: false, targetProximityBlocked: false, targetDistancePct: null, reason: null },
    { symbol: "BNB", state: "active", timingPhase: "preflight_warmup", effectiveBandMin: 0.55, effectiveBandMax: 0.85, effectiveWindowSeconds: 300, effectiveBudgetDollars: 25, lastAsk: null, secondsRemaining: null, secondsUntilEligible: 22, freefallBlocked: false, targetProximityBlocked: false, targetDistancePct: null, reason: null },
    { symbol: "DOGE", state: "idle", timingPhase: "closed_expired", effectiveBandMin: 0.55, effectiveBandMax: 0.85, effectiveWindowSeconds: 300, effectiveBudgetDollars: 25, lastAsk: null, secondsRemaining: null, secondsUntilEligible: null, freefallBlocked: false, targetProximityBlocked: false, targetDistancePct: null, reason: null },
  ],
  unresolvedAttempts: [],
};

const MOCK_PERF: ScalperPerformance = {
  mode: "paper",
  trackingSince: isoMinutesAgo(60 * 24 * 7),
  totalOrders: 96,
  filledOrders: 61,
  settled: 58,
  wins: 39,
  losses: 19,
  winRate: 0.672,
  totalPnl: 214.38,
  totalSpent: 1462.5,
  avgFillPrice: 0.68,
  bySymbol: [
    { symbol: "BTC", orders: 22, settled: 20, wins: 15, losses: 5, winRate: 0.75, pnl: 118.4, spent: 640, avgFillPrice: 0.66 },
    { symbol: "ETH", orders: 18, settled: 16, wins: 11, losses: 5, winRate: 0.6875, pnl: 62.1, spent: 420, avgFillPrice: 0.69 },
    { symbol: "SOL", orders: 12, settled: 11, wins: 7, losses: 4, winRate: 0.636, pnl: 24.8, spent: 240, avgFillPrice: 0.7 },
    { symbol: "XRP", orders: 9, settled: 8, wins: 4, losses: 4, winRate: 0.5, pnl: -9.2, spent: 112.5, avgFillPrice: 0.72 },
    { symbol: "BNB", orders: 3, settled: 3, wins: 2, losses: 1, winRate: 0.667, pnl: 18.28, spent: 50, avgFillPrice: 0.64 },
  ],
};

type MutationName = "enable" | "breaker" | "mode" | "save" | "reset" | "performance-reset";

// ─────────────────────────────────────────────────────────────────────────────
export function Current() {
  // Static stubs replacing @clerk/react + React Query + authPost
  const canManage = true;
  const capabilityLoading = false;
  const cfg = MOCK_CONFIG;
  const statusData = MOCK_STATUS;
  const perfData = MOCK_PERF;

  const [configDraft, setConfigDraft] = useState<Partial<ScalperConfig>>({});
  const [mutationBusy] = useState<MutationName | null>(null);
  const [attemptPage, setAttemptPage] = useState(0);
  const ATTEMPT_PAGE_SIZE = 8;

  const merged = { ...cfg, ...configDraft } as ScalperConfig;
  const scalperMode = merged.mode ?? "paper";
  const hasDraft = Object.keys(configDraft).length > 0;

  function readableReason(reason: string | null): string {
    if (!reason) return "Awaiting Kalshi reconciliation";
    return reason.replaceAll("_", " ");
  }

  function handleConfigChange(key: keyof ScalperConfig, value: any) {
    setConfigDraft(prev => ({ ...prev, [key]: value }));
  }

  function handleMarketChange(sym: string, key: keyof ScalperConfig["perMarketOverrides"][number], value: any) {
    setConfigDraft(prev => {
      const pmList = prev.perMarketOverrides || cfg?.perMarketOverrides || [];
      const index = pmList.findIndex(m => m.symbol === sym);
      let newList = [...pmList];
      if (index >= 0) {
        newList[index] = { ...newList[index], [key]: value };
      } else {
        newList.push({ symbol: sym, [key]: value });
      }
      return { ...prev, perMarketOverrides: newList };
    });
  }

  function setScalperMode(mode: "paper" | "live") {
    if (mode === scalperMode) return;
    handleConfigChange("mode", mode);
  }
  function toggleCircuitBreakerProtection() {
    handleConfigChange("circuitBreakerEnabled", !(merged.circuitBreakerEnabled ?? true));
  }
  function toggleMaster() {
    handleConfigChange("enabled", !(merged.enabled ?? false));
  }

  return (
    <div className="dark min-h-screen bg-background text-foreground font-sans p-4">
    <div className="min-w-0 bg-card border-amber-500/30 border rounded-xl overflow-hidden mb-6">
      <div className="px-3 sm:px-5 py-4 border-b border-amber-500/30 flex flex-col items-stretch gap-4 bg-amber-500/5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col">
          <div className="flex items-center gap-2">
            <Zap className="w-5 h-5 text-amber-400" />
            <h2 className="font-bold text-lg text-foreground tracking-tight">High-Value Scalping</h2>
          </div>
          <span className="text-[10px] uppercase font-bold tracking-widest text-amber-500/70 mt-0.5">Late-Window Price Execution</span>
        </div>
        <div className="grid w-full grid-cols-3 items-end gap-2 sm:w-auto sm:flex sm:flex-wrap sm:gap-x-4 sm:gap-y-2 sm:justify-end">
          <div className="flex flex-col gap-1">
            <span className="text-[9px] uppercase font-bold tracking-widest text-muted-foreground">Scalper mode</span>
            <div className="flex rounded-lg border border-border bg-background/50 p-0.5" role="group" aria-label="Scalper execution mode">
              {(["paper", "live"] as const).map(mode => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setScalperMode(mode)}
                  disabled={!canManage || mutationBusy !== null}
                  aria-pressed={scalperMode === mode}
                  className={`px-3 py-1 rounded-md text-[10px] font-bold tracking-widest uppercase transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                    scalperMode === mode
                      ? mode === "live" ? "bg-red-500/25 text-red-300" : "bg-yellow-500/20 text-yellow-300"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {mode}
                </button>
              ))}
            </div>
          </div>
          <button
            type="button"
            role="switch"
            data-testid="switch-scalper-circuit-breaker"
            aria-checked={merged.circuitBreakerEnabled !== false}
            aria-label="Enable or disable Scalper circuit-breaker protection"
            onClick={toggleCircuitBreakerProtection}
            disabled={!canManage || mutationBusy !== null}
            className="flex flex-col items-start gap-1 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span className="text-[9px] uppercase font-bold tracking-widest text-muted-foreground">Circuit Breaker</span>
            <span className="flex items-center gap-2">
              <span className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${merged.circuitBreakerEnabled !== false ? "bg-emerald-500" : "bg-red-500"}`}>
                <span className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${merged.circuitBreakerEnabled !== false ? "translate-x-5" : "translate-x-0"}`} />
              </span>
              <span className={`text-xs font-bold whitespace-nowrap ${merged.circuitBreakerEnabled !== false ? "text-emerald-400" : "text-red-300"}`}>
                {mutationBusy === "breaker" ? "Saving…" : merged.circuitBreakerEnabled !== false ? "Protected" : "Off"}
              </span>
            </span>
          </button>
          <button
            type="button"
            role="switch"
            aria-checked={Boolean(merged.enabled)}
            aria-label="Enable or disable the Scalper"
            onClick={toggleMaster}
            disabled={!canManage || mutationBusy !== null}
            className="flex flex-col items-start gap-1 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span className="text-[9px] uppercase font-bold tracking-widest text-muted-foreground">Enable Scalper</span>
            <span className="flex items-center gap-2">
              <span className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${merged.enabled ? "bg-emerald-500" : "bg-muted"}`}>
                <span className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${merged.enabled ? "translate-x-5" : "translate-x-0"}`} />
              </span>
              <span className={`text-xs font-bold whitespace-nowrap ${merged.enabled ? "text-emerald-400" : "text-muted-foreground"}`}>
                {mutationBusy === "enable" ? "Saving…" : merged.enabled ? "On" : "Off"}
              </span>
            </span>
          </button>
        </div>
      </div>

      <div className={`px-3 sm:px-5 py-2.5 border-b text-xs leading-relaxed flex items-start gap-2 ${
        canManage ? "border-emerald-500/20 bg-emerald-500/5 text-emerald-300" : "border-amber-500/25 bg-amber-500/10 text-amber-300"
      }`}>
        <Shield className="w-4 h-4 shrink-0" />
        {capabilityLoading ? "Checking signed-in access…" : "Signed-in access verified — Scalper controls and saving are enabled."}
      </div>

      {merged.circuitBreakerEnabled === false && (
        <div data-testid="warning-scalper-circuit-breaker-disabled" className="px-3 sm:px-5 py-3 border-b border-amber-500/30 bg-amber-500/10 text-amber-200 flex items-start gap-2 text-xs">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>Circuit-breaker protection is off. The Scalper will keep recording safety events and their reasons, but those events will not pause new attempts.</span>
        </div>
      )}

      <div className="p-3 sm:p-5 text-xs text-muted-foreground/80 leading-relaxed border-b border-border bg-card/40 flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
        <span className="min-w-0 break-words">An in-band scan is only a preliminary candidate. Preflight warms balance, cap headroom, market identity, and Freefall samples before the execution window. During the window, the Scalper scans four times per second and fetches one authoritative authenticated quote before each IOC submission. Confirmed zero fills can retry up to three total submissions; only confirmed fills appear in Active Positions and Transaction History.</span>
        {statusData && (
          <div className="grid w-full grid-cols-3 gap-2 text-[10px] font-mono sm:w-auto sm:shrink-0 sm:ml-4 sm:flex sm:items-center sm:gap-4">
            <div className="flex min-w-0 flex-col items-start sm:items-end">
              <span className="text-muted-foreground/50 uppercase tracking-widest">Reservations</span>
              <span className="text-foreground">{statusData.totalReservationsToday} today</span>
            </div>
            <div className="flex min-w-0 flex-col items-start sm:items-end">
              <span className="text-muted-foreground/50 uppercase tracking-widest">Open / Cap</span>
              <span data-testid="text-scalper-open-cap" className="text-foreground">
                {fmt$(statusData.openSpend)} / {fmt$(statusData.config.openCapDollars)}
              </span>
            </div>
            <div className="flex min-w-0 flex-col items-start sm:items-end">
              <span className="text-muted-foreground/50 uppercase tracking-widest">Spent</span>
              <span className="text-foreground">{fmt$(statusData.dailySpend)}</span>
            </div>
          </div>
        )}
      </div>

      {statusData?.preflight && (
        <div
          data-testid="status-scalper-preflight"
          className={`border-b px-3 sm:px-5 py-3 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between ${
            statusData.preflight.state === "ready"
              ? "border-emerald-500/25 bg-emerald-500/5 text-emerald-300"
              : statusData.preflight.state === "blocked"
                ? "border-red-500/25 bg-red-500/5 text-red-300"
                : statusData.preflight.state === "warming"
                  ? "border-amber-500/25 bg-amber-500/5 text-amber-300"
                  : "border-border bg-background/30 text-muted-foreground"
          }`}
        >
          <div className="flex items-center gap-2 text-xs font-semibold">
            {statusData.preflight.state === "ready"
              ? <CheckCircle2 className="w-4 h-4 shrink-0" />
              : statusData.preflight.state === "blocked"
                ? <AlertTriangle className="w-4 h-4 shrink-0" />
                : <Activity className="w-4 h-4 shrink-0" />}
            <span>
              {statusData.preflight.state === "ready"
                ? "Non-submitting warm-up complete"
                : statusData.preflight.state === "warming"
                  ? "Non-submitting warm-up in progress"
                  : statusData.preflight.state === "blocked"
                    ? "Warm-up blocked — no order submitted"
                    : "Waiting to start non-submitting warm-up"}
              {statusData.preflight.totalSymbols > 0
                ? ` · ${statusData.preflight.readySymbols}/${statusData.preflight.totalSymbols} markets ready`
                : ""}
            </span>
          </div>
          <div className="text-[10px] font-mono opacity-80">
            {statusData.preflight.reason
              ? statusData.preflight.reason.replaceAll("_", " ")
              : statusData.preflight.state === "idle" && statusData.preflight.startsInSeconds != null
                ? `starts in ${Math.ceil(statusData.preflight.startsInSeconds)}s`
                : statusData.preflight.checkedAt
                  ? `checked ${fmtDateTime(statusData.preflight.checkedAt)}`
                  : `starts ${statusData.executionPolicy.preflightLeadSeconds}s before entry`}
          </div>
          {statusData.preflight.markets.some((market) => !market.ready) && (
            <div className="text-[10px] font-mono opacity-75 sm:text-right">
              {statusData.preflight.markets
                .filter((market) => !market.ready)
                .map((market) => `${market.symbol}: ${market.reason?.replaceAll("_", " ") ?? "not ready"}`)
                .join(" · ")}
            </div>
          )}
        </div>
      )}

      {statusData?.latency && statusData.latency.sampleSize > 0 && (
        <div data-testid="status-scalper-fast-path-latency" className="border-b border-amber-500/15 bg-amber-500/[0.03] px-5 py-2 text-[10px] font-mono text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="uppercase tracking-widest text-amber-500/70 font-bold">Fast path</span>
          <span>p50 {formatScalperLatency(statusData.latency.p50Ms)}</span>
          <span>p90 {formatScalperLatency(statusData.latency.p90Ms)}</span>
          <span>p99 {formatScalperLatency(statusData.latency.p99Ms)}</span>
          <span className="sm:ml-auto">{statusData.latency.sampleSize} measured attempt{statusData.latency.sampleSize === 1 ? "" : "s"}</span>
        </div>
      )}

      {statusData?.lastError && (
        <div className="bg-amber-500/10 border-b border-amber-500/30 px-5 py-2 flex items-center gap-3 text-amber-400/80 text-xs">
          <AlertTriangle className="w-4 h-4" />
          Scanner Error: {statusData.lastError}
        </div>
      )}

      <div className="p-3 sm:p-5 space-y-4 sm:space-y-6">
        <fieldset disabled={!canManage || mutationBusy !== null} className={`min-w-0 space-y-4 sm:space-y-6 ${!canManage ? "opacity-65" : ""}`}>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="min-w-0 bg-background/50 border border-border rounded-lg p-3 sm:p-4 flex flex-col justify-between">
            <div>
              <div className="flex flex-wrap items-center justify-between gap-2 mb-3 sm:mb-4">
                <div className="text-[10px] font-bold text-amber-500/70 uppercase tracking-widest">Winning Contract Band</div>
                <div className="text-[10px] font-bold text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded-full">{Math.round(merged.globalBandMin * 100)}–{Math.round(merged.globalBandMax * 100)}¢</div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <label className="min-w-0 flex flex-col gap-1.5">
                  <span className="text-[10px] text-muted-foreground">Minimum</span>
                  <div className="relative">
                    <input type="number" min={1} max={99} value={Math.round(merged.globalBandMin * 100)} onChange={e => handleConfigChange("globalBandMin", (parseInt(e.target.value) || 0) / 100)} className="w-full min-w-0 bg-background border border-border rounded-md px-3 py-2 sm:py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-amber-500/50" />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground/50 text-xs">¢</span>
                  </div>
                </label>
                <label className="min-w-0 flex flex-col gap-1.5">
                  <span className="text-[10px] text-muted-foreground">Maximum</span>
                  <div className="relative">
                    <input type="number" min={1} max={99} value={Math.round(merged.globalBandMax * 100)} onChange={e => handleConfigChange("globalBandMax", (parseInt(e.target.value) || 0) / 100)} className="w-full min-w-0 bg-background border border-border rounded-md px-3 py-2 sm:py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-amber-500/50" />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground/50 text-xs">¢</span>
                  </div>
                </label>
              </div>
            </div>
          </div>

          <div className="min-w-0 bg-background/50 border border-border rounded-lg p-3 sm:p-4 flex flex-col justify-between">
            <div>
              <div className="text-[10px] font-bold text-amber-500/70 uppercase tracking-widest mb-4">Entry Cadence</div>
              <div className="grid grid-cols-2 gap-3 mb-3">
                <label className="min-w-0 flex flex-col gap-1.5">
                  <span className="text-[10px] text-muted-foreground">Final minutes</span>
                  <input type="number" min={0} max={14} value={Math.floor(merged.finalWindowSeconds / 60)} onChange={e => handleConfigChange("finalWindowSeconds", (parseInt(e.target.value) || 0) * 60 + (merged.finalWindowSeconds % 60))} className="w-full bg-background border border-border rounded-md px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-amber-500/50" />
                </label>
                <label className="min-w-0 flex flex-col gap-1.5">
                  <span className="text-[10px] text-muted-foreground">Final seconds</span>
                  <input type="number" min={0} max={59} value={merged.finalWindowSeconds % 60} onChange={e => handleConfigChange("finalWindowSeconds", Math.floor(merged.finalWindowSeconds / 60) * 60 + (parseInt(e.target.value) || 0))} className="w-full bg-background border border-border rounded-md px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-amber-500/50" />
                </label>
              </div>
              <label className="flex flex-col gap-1.5">
                <span className="text-[10px] text-muted-foreground">Per order</span>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/50 text-xs">$</span>
                  <input type="number" min={1} max={100} value={merged.budgetDollars} onChange={e => handleConfigChange("budgetDollars", parseFloat(e.target.value) || 0)} className="w-full bg-background border border-border rounded-md pl-6 pr-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-amber-500/50" />
                </div>
              </label>
            </div>
            <div className="text-[9px] text-muted-foreground/60 mt-3 leading-tight">
              Scans every {statusData?.executionPolicy.scanIntervalMs ?? 250}ms. IOC zero fills cool down briefly and retry up to {statusData?.executionPolicy.maxSubmissionsPerWindow ?? 3} total submissions.
            </div>
          </div>

          <div className="min-w-0 bg-background/50 border border-border rounded-lg p-3 sm:p-4 flex flex-col justify-between">
            <div>
              <div className="text-[10px] font-bold text-amber-500/70 uppercase tracking-widest mb-4">Independent Limits</div>
              <div className="grid grid-cols-1 gap-3">
                <label className="flex flex-col gap-1.5">
                  <div className="flex justify-between items-center">
                    <span className="text-[10px] text-muted-foreground">Open exposure cap</span>
                    <span className="text-[9px] font-bold text-amber-400/80">REQUIRED</span>
                  </div>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/50 text-xs">$</span>
                    <input data-testid="input-scalper-open-cap" type="number" min={0.01} step={0.01} value={merged.openCapDollars} onChange={e => handleConfigChange("openCapDollars", parseFloat(e.target.value) || 0)} className="w-full bg-background border border-border rounded-md pl-6 pr-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-amber-500/50" />
                  </div>
                  <span className="text-[9px] text-muted-foreground/60 leading-tight">Your chosen limit for unsettled fills and in-flight reservations across every Scalper market.</span>
                </label>
                <label className="flex flex-col gap-1.5">
                  <div className="flex justify-between items-center">
                    <span className="text-[10px] text-muted-foreground">Daily spend</span>
                    {merged.dailyCapDollars === null && <span className="text-[9px] font-bold text-muted-foreground/50">NO CAP</span>}
                  </div>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/50 text-xs">$</span>
                    <input type="number" value={merged.dailyCapDollars || ""} placeholder="No cap" onChange={e => handleConfigChange("dailyCapDollars", e.target.value ? parseFloat(e.target.value) : null)} className="w-full bg-background border border-border rounded-md pl-6 pr-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-amber-500/50" />
                  </div>
                </label>
              </div>
            </div>
            <div className="flex items-center justify-between mt-3">
              <div className="text-[9px] text-muted-foreground/60 leading-tight pr-2">Separate from normal bets. One scalp per market per 15-min window.</div>
              <button
                type="button"
                role="switch"
                aria-checked={merged.freefallGuardEnabled}
                onClick={() => handleConfigChange("freefallGuardEnabled", !merged.freefallGuardEnabled)}
                className="flex items-center gap-1.5 shrink-0"
                title="Toggle Freefall Guard"
              >
                <span className={`relative h-5 w-9 rounded-full transition-colors ${merged.freefallGuardEnabled ? "bg-amber-500" : "bg-muted"}`}>
                  <span className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${merged.freefallGuardEnabled ? "translate-x-4" : "translate-x-0"}`} />
                </span>
                <span className="text-[10px] text-muted-foreground/50"><Shield className="w-3 h-3 inline" /> Guard</span>
              </button>
            </div>
          </div>
        </div>

        <div className="bg-background/50 border border-amber-500/20 rounded-lg p-4">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="min-w-0 flex items-start gap-3">
              <div className="rounded-md bg-amber-500/10 p-2 text-amber-400">
                <Target className="w-4 h-4" />
              </div>
              <div className="min-w-0">
                <div className="text-[10px] font-bold text-amber-500/70 uppercase tracking-widest">Target Distance Guard</div>
                <p className="break-words text-[10px] text-muted-foreground mt-1 max-w-xl leading-relaxed">
                  Stay out when the fresh underlying price is within the configured distance of the Kalshi target, regardless of which side is in band.
                </p>
              </div>
            </div>
            <div className="flex w-full items-center gap-3 sm:gap-4 md:w-auto md:shrink-0">
              <label className={`min-w-0 flex flex-1 items-center gap-2 md:flex-none ${!merged.targetProximityGuardEnabled ? "opacity-50" : ""}`}>
                <span className="text-[10px] text-muted-foreground">Minimum distance</span>
                <div className="relative min-w-20 flex-1 md:w-24 md:flex-none">
                  <input
                    type="number" min={0.01} max={10} step={0.01}
                    value={merged.targetProximityThresholdPct}
                    onChange={e => handleConfigChange("targetProximityThresholdPct", parseFloat(e.target.value) || 0)}
                    disabled={!merged.targetProximityGuardEnabled}
                    data-testid="input-scalper-target-proximity-threshold"
                    className="w-full bg-background border border-border rounded-md pl-3 pr-7 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-amber-500/50 disabled:cursor-not-allowed"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground/50 text-xs">%</span>
                </div>
              </label>
              <button
                type="button"
                role="switch"
                aria-checked={merged.targetProximityGuardEnabled}
                data-testid="switch-scalper-target-proximity"
                onClick={() => handleConfigChange("targetProximityGuardEnabled", !merged.targetProximityGuardEnabled)}
                className={`relative h-6 w-11 rounded-full transition-colors ${merged.targetProximityGuardEnabled ? "bg-amber-500" : "bg-muted"}`}
                title="Toggle Target Distance Guard"
              >
                <span className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${merged.targetProximityGuardEnabled ? "translate-x-5" : "translate-x-0"}`} />
                <span className="sr-only">Target Distance Guard</span>
              </button>
            </div>
          </div>
        </div>

        <div>
          <div className="flex items-center gap-2 mb-3">
            <Settings2 className="w-4 h-4 text-amber-500/70" />
            <h3 className="text-xs font-bold text-amber-500/70 tracking-widest uppercase">Per-Coin Overrides</h3>
          </div>
          <div className="bg-background/50 border border-border rounded-lg overflow-hidden sm:overflow-x-auto">
            <table className="block w-full text-sm sm:table sm:min-w-[760px]">
              <tbody className="block sm:table-row-group">
                {PER_MARKET_SYMBOLS.map(sym => {
                  const pm = merged.perMarketOverrides?.find(m => m.symbol === sym) || { symbol: sym };
                  const isPaused = pm.paused ?? false;
                  const statusInfo = statusData?.markets.find(m => m.symbol === sym);
                  const timingLabel = statusInfo?.timingPhase === "eligible"
                    ? `Submission eligible · ${statusInfo.secondsRemaining == null ? "time unknown" : `${Math.max(0, Math.ceil(statusInfo.secondsRemaining))}s left`} · ${statusInfo.effectiveWindowSeconds}s window`
                    : statusInfo?.timingPhase === "preflight_warmup"
                      ? `Warm-up only · eligible in ${Math.max(0, Math.ceil(statusInfo.secondsUntilEligible ?? 0))}s`
                      : statusInfo?.timingPhase === "closed_expired"
                        ? "Window closed"
                        : statusInfo
                          ? `Waiting · eligible in ${statusInfo.secondsUntilEligible == null ? "—" : `${Math.max(0, Math.ceil(statusInfo.secondsUntilEligible))}s`}`
                          : null;
                  const scannerLabel = statusInfo?.state === "active"
                    ? (statusInfo.lastAsk !== null ? `candidate · ${Math.round(statusInfo.lastAsk * 100)}¢` : "scanning")
                    : statusInfo?.state === "guarded"
                      ? `blocked · ${readableReason(statusInfo.reason)}`
                      : statusInfo?.state;
                  const statusLabel = [timingLabel, scannerLabel].filter(Boolean).join(" · ");

                  return (
                    <tr key={sym} className={`block p-3 border-b border-border/40 last:border-0 hover:bg-muted/10 transition-colors sm:table-row sm:p-0 ${isPaused ? "bg-red-500/5" : ""}`}>
                      <td className="inline-block w-auto px-0 py-1 pr-3 font-bold sm:table-cell sm:w-20 sm:px-4 sm:py-2">{sym}</td>
                      <td className="inline-block w-auto px-0 py-1 sm:table-cell sm:w-28 sm:px-2 sm:py-2">
                        <button
                          onClick={() => handleMarketChange(sym, "paused", !isPaused)}
                          className={`flex items-center gap-1.5 px-2 py-1 rounded text-[10px] font-bold transition-colors ${
                            isPaused ? "bg-red-500/20 text-red-400 border border-red-500/30" : "text-muted-foreground hover:bg-muted"
                          }`}
                        >
                          <Pause className="w-3 h-3" />
                          {isPaused ? "Paused" : "Pause"}
                        </button>
                      </td>
                      <td className="block px-0 pt-3 pb-0 sm:table-cell sm:px-2 sm:py-2">
                        <div className="flex flex-wrap items-center gap-3">
                          <div className={`flex items-center gap-1 ${isPaused ? "opacity-50" : ""}`}>
                            <span className="text-[10px] text-muted-foreground">Band</span>
                            <input type="number" min={1} max={99}
                              placeholder={Math.round(merged.globalBandMin * 100).toString()}
                              value={pm.minBand !== undefined && pm.minBand !== null ? Math.round(pm.minBand * 100) : ""}
                              onChange={e => handleMarketChange(sym, "minBand", e.target.value ? parseFloat(e.target.value) / 100 : null)}
                              className="w-10 bg-background border border-border rounded px-1.5 py-0.5 text-[11px] font-mono text-center focus:outline-none focus:ring-1 focus:ring-amber-500/50"
                              disabled={isPaused}
                            />
                            <span className="text-[10px] text-muted-foreground">–</span>
                            <input type="number" min={1} max={99}
                              placeholder={Math.round(merged.globalBandMax * 100).toString()}
                              value={pm.maxBand !== undefined && pm.maxBand !== null ? Math.round(pm.maxBand * 100) : ""}
                              onChange={e => handleMarketChange(sym, "maxBand", e.target.value ? parseFloat(e.target.value) / 100 : null)}
                              className="w-10 bg-background border border-border rounded px-1.5 py-0.5 text-[11px] font-mono text-center focus:outline-none focus:ring-1 focus:ring-amber-500/50"
                              disabled={isPaused}
                            />
                            <span className="text-[10px] text-muted-foreground">¢</span>
                          </div>

                          <div className="relative w-20">
                            <span className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground/50 text-[10px]">$</span>
                            <input type="number"
                              placeholder={merged.budgetDollars.toString()}
                              value={pm.budgetDollars === null ? "" : pm.budgetDollars ?? ""}
                              onChange={e => handleMarketChange(sym, "budgetDollars", e.target.value ? parseFloat(e.target.value) : null)}
                              className={`w-full bg-background border rounded pl-5 pr-2 py-0.5 text-[11px] font-mono focus:outline-none focus:ring-1 focus:ring-amber-500/50 ${isPaused ? "border-red-500/30 opacity-50" : "border-border"}`}
                              disabled={isPaused}
                            />
                          </div>

                          <div className={`flex items-center gap-1 ${isPaused ? "opacity-50" : ""}`}>
                            <span className="text-[10px] text-muted-foreground">window</span>
                            <input type="number" min={0} max={14}
                              placeholder={Math.floor(merged.finalWindowSeconds / 60).toString()}
                              value={pm.windowSeconds !== undefined && pm.windowSeconds !== null ? Math.floor(pm.windowSeconds / 60) : ""}
                              onChange={e => {
                                const m = e.target.value ? parseInt(e.target.value) : null;
                                if (m === null) handleMarketChange(sym, "windowSeconds", null);
                                else {
                                  const current = pm.windowSeconds ?? merged.finalWindowSeconds;
                                  handleMarketChange(sym, "windowSeconds", m * 60 + (current % 60));
                                }
                              }}
                              className="w-10 bg-background border border-border rounded px-1.5 py-0.5 text-[11px] font-mono text-center focus:outline-none focus:ring-1 focus:ring-amber-500/50"
                              disabled={isPaused}
                            />
                            <span className="text-[10px] text-muted-foreground">m</span>
                            <input type="number" min={0} max={59}
                              placeholder={(merged.finalWindowSeconds % 60).toString()}
                              value={pm.windowSeconds !== undefined && pm.windowSeconds !== null ? (pm.windowSeconds % 60) : ""}
                              onChange={e => {
                                const s = e.target.value ? parseInt(e.target.value) : null;
                                if (s === null) handleMarketChange(sym, "windowSeconds", null);
                                else {
                                  const current = pm.windowSeconds ?? merged.finalWindowSeconds;
                                  handleMarketChange(sym, "windowSeconds", Math.floor(current / 60) * 60 + s);
                                }
                              }}
                              className="w-10 bg-background border border-border rounded px-1.5 py-0.5 text-[11px] font-mono text-center focus:outline-none focus:ring-1 focus:ring-amber-500/50"
                              disabled={isPaused}
                            />
                            <span className="text-[10px] text-muted-foreground">s</span>
                          </div>

                          {statusInfo && !isPaused && (
                            <div className="ml-auto flex items-center gap-2">
                              {statusInfo.freefallBlocked && (
                                <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300" title="Freefall guard active">FREEFALL</span>
                              )}
                              {statusInfo.targetProximityBlocked && (
                                <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-red-500/20 text-red-300"
                                  title={statusInfo.targetDistancePct != null ? `Target distance ${(statusInfo.targetDistancePct).toFixed(3)}%` : "Target distance unavailable"}>
                                  TARGET
                                </span>
                              )}
                              <span data-testid={`text-scalper-timing-${sym}`} className="text-[9px] text-muted-foreground/60 w-52 text-right"
                                title={`${statusLabel}. Warm-up never submits an order; an authenticated quote and all guards are rechecked immediately before Paper/Live execution.`}>
                                {statusLabel}
                              </span>
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="text-[9px] text-muted-foreground/60 mt-2 px-1">
            Pause blocks this coin from scalping. Settings override the global band, per-order budget, and how early the scalper starts. Blank = use global. Save to apply.
          </div>
        </div>

        {hasDraft && (
          <div className="flex items-center justify-end gap-3 mt-4 pt-4 border-t border-border/50">
            <span className="text-xs text-amber-500/70">Unsaved changes</span>
            <button onClick={() => setConfigDraft({})} disabled={mutationBusy !== null} className="text-xs text-muted-foreground hover:text-foreground">Discard</button>
            <button disabled={mutationBusy !== null || !canManage} className="bg-amber-600 hover:bg-amber-500 text-amber-50 px-4 py-1.5 rounded font-bold text-xs transition-colors shadow disabled:opacity-50 disabled:cursor-not-allowed">
              {mutationBusy === "save" ? "Saving..." : "Save settings"}
            </button>
          </div>
        )}
        </fieldset>

        {(statusData?.recentAttempts?.length ?? 0) > 0 && (() => {
          const totalAttempts = statusData!.recentAttempts.length;
          const totalPages = Math.ceil(totalAttempts / ATTEMPT_PAGE_SIZE);
          const safePage = Math.min(attemptPage, totalPages - 1);
          const pagedAttempts = statusData!.recentAttempts.slice(safePage * ATTEMPT_PAGE_SIZE, (safePage + 1) * ATTEMPT_PAGE_SIZE);
          return (
            <div className="mt-8 border-t border-amber-500/20 pt-6">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mb-3">
                <Target className="w-4 h-4 text-amber-500/70 shrink-0" />
                <h3 className="text-xs font-bold text-amber-500/70 tracking-widest uppercase">Recent candidate checks</h3>
                <span className="text-[10px] text-muted-foreground">Operational outcomes, not all completed bets</span>
                <span className="ml-auto text-[10px] text-muted-foreground">{totalAttempts} total</span>
              </div>
              <div className="space-y-2">
                {pagedAttempts.map((attempt) => {
                  const isFilled = attempt.status === "filled";
                  const isUnsafe = attempt.status === "unknown" || attempt.status === "error";
                  const isZeroFill = attempt.status === "zero_fill";
                  const executionPricing = attempt.observedWinningAsk != null && attempt.executionWinningLimit != null
                    ? `${(attempt.observedWinningAsk * 100).toFixed(1).replace(/\.0$/, "")}¢ quote → ${(attempt.executionWinningLimit * 100).toFixed(1).replace(/\.0$/, "")}¢ ${attempt.mode === "live" ? "IOC" : "sim"} cap`
                    : null;
                  const evidenceLines = describeScalperEvidence(attempt);
                  const retryText = isZeroFill
                    ? (attempt.retryEligible
                        ? attempt.retryState === "ready"
                          ? `Retry ready · ${attempt.submissionCount}/${statusData!.executionPolicy.maxSubmissionsPerWindow} used`
                          : `Retry in ${Math.max(0.1, (attempt.retryAfterMs ?? 0) / 1_000).toFixed(1)}s · ${attempt.submissionCount}/${statusData!.executionPolicy.maxSubmissionsPerWindow} used`
                        : `${attempt.submissionCount}/${statusData!.executionPolicy.maxSubmissionsPerWindow} submissions used`)
                    : (!isZeroFill && attempt.retryEligible
                        ? attempt.retryState === "ready"
                          ? "Transient skip · retry ready"
                          : `Transient skip · ${Math.max(0.1, (attempt.retryAfterMs ?? 0) / 1_000).toFixed(1)}s`
                        : null);
                  return (
                    <div key={attempt.id} className="rounded-lg border border-border bg-background/40 px-3 py-2">
                      <div className="flex items-center gap-2 text-xs min-w-0">
                        <span className="font-bold text-foreground w-10 shrink-0">{attempt.symbol}</span>
                        <span className={`font-semibold min-w-0 truncate ${
                          isFilled ? "text-emerald-400" : isUnsafe ? "text-red-400" : isZeroFill ? "text-sky-400" : "text-amber-300"
                        }`}>
                          {describeScalperAttempt(attempt)}
                        </span>
                        <span className={`ml-auto shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded ${
                          attempt.mode === "live" ? "bg-red-500/15 text-red-400" : "bg-yellow-500/15 text-yellow-400"
                        }`}>
                          {attempt.mode.toUpperCase()}
                        </span>
                      </div>
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-1 pl-0 sm:pl-12 text-[10px] text-muted-foreground">
                        {executionPricing && (
                          <span className="font-mono text-amber-200/75" title={`Latest ${attempt.mode === "live" ? "submitted" : "simulated"} ${attempt.side?.toUpperCase() ?? ""} quote`}>
                            {executionPricing}
                          </span>
                        )}
                        {retryText && <span>{retryText}</span>}
                        <span data-testid={`text-scalper-attempt-timestamp-${attempt.id}`} className="ml-auto whitespace-nowrap">
                          Guard checked {fmtDateTime(attempt.attemptedAt)}
                        </span>
                      </div>
                      {evidenceLines.length > 0 && (
                        <div data-testid={`text-scalper-skip-evidence-${attempt.id}`} className="mt-1.5 pl-0 sm:pl-12 flex flex-col gap-0.5 text-[10px] font-mono text-muted-foreground/80">
                          {evidenceLines.map((line) => <span key={line}>{line}</span>)}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              {totalPages > 1 && (
                <div className="flex items-center justify-between mt-3 pt-3 border-t border-amber-500/10">
                  <button type="button" onClick={() => setAttemptPage(p => Math.max(0, p - 1))} disabled={safePage === 0}
                    className="text-[10px] font-bold text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed px-2 py-1 rounded border border-border hover:border-amber-500/40 transition-colors">
                    ← Prev
                  </button>
                  <span className="text-[10px] text-muted-foreground">Page {safePage + 1} of {totalPages}</span>
                  <button type="button" onClick={() => setAttemptPage(p => Math.min(totalPages - 1, p + 1))} disabled={safePage >= totalPages - 1}
                    className="text-[10px] font-bold text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed px-2 py-1 rounded border border-border hover:border-amber-500/40 transition-colors">
                    Next →
                  </button>
                </div>
              )}
            </div>
          );
        })()}

        {perfData && (
          <div className="mt-8 border-t border-amber-500/20 pt-6">
            <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 mb-4">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <Activity className="w-4 h-4 text-amber-500/70" />
                  <h3 className="text-xs font-bold text-amber-500/70 tracking-widest uppercase">Performance</h3>
                  <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-400">{perfData.settled} settled</span>
                  {perfData.mode !== merged.mode && (
                    <span className="text-[10px] ml-2 text-muted-foreground">(Showing {perfData.mode} data while viewing {merged.mode})</span>
                  )}
                </div>
                <div className="mt-1 text-[10px] text-muted-foreground" data-testid="text-scalper-performance-tracking-since">
                  Tracking {perfData.mode === "paper" ? "Paper" : "Live"} entries since {fmtDateTime(perfData.trackingSince)}
                </div>
              </div>
              <button type="button" data-testid="button-scalper-reset-performance" disabled={!canManage || mutationBusy !== null}
                title={`Start a new ${perfData.mode} reporting window without deleting order history`}
                className="inline-flex items-center justify-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/5 px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wide text-amber-300 transition-colors hover:bg-amber-500/10 disabled:cursor-not-allowed disabled:opacity-50">
                <RotateCcw className={`h-3 w-3 ${mutationBusy === "performance-reset" ? "animate-spin" : ""}`} />
                {mutationBusy === "performance-reset" ? "Resetting…" : "Reset stats"}
              </button>
            </div>

            <div className="grid grid-cols-1 min-[360px]:grid-cols-2 md:grid-cols-4 gap-2 sm:gap-3 mb-4">
              <div className="bg-background/50 border border-border rounded-lg p-3">
                <div className="text-[9px] uppercase tracking-wide text-muted-foreground mb-1">Win Rate</div>
                <div className="text-xl font-bold text-emerald-400">{perfData.winRate !== null ? `${Math.round(perfData.winRate * 100)}%` : "—"}</div>
                <div className="text-[9px] text-muted-foreground mt-0.5">{perfData.wins}W - {perfData.losses}L</div>
              </div>
              <div className="bg-background/50 border border-border rounded-lg p-3">
                <div className="text-[9px] uppercase tracking-wide text-muted-foreground mb-1">Net P&L</div>
                <div className={`text-xl font-bold ${perfData.totalPnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                  {perfData.totalPnl > 0 ? "+" : ""}{fmt$(perfData.totalPnl)}
                </div>
                <div className="text-[9px] text-muted-foreground mt-0.5">{fmt$(perfData.totalSpent)} spent</div>
              </div>
              <div className="bg-background/50 border border-border rounded-lg p-3">
                <div className="text-[9px] uppercase tracking-wide text-muted-foreground mb-1">Settled Bets</div>
                <div className="text-xl font-bold text-foreground">{perfData.settled}</div>
                <div className="text-[9px] text-muted-foreground mt-0.5">no pushes</div>
              </div>
              <div className="bg-background/50 border border-border rounded-lg p-3">
                <div className="text-[9px] uppercase tracking-wide text-muted-foreground mb-1">Avg Fill</div>
                <div className="text-xl font-bold text-amber-400">
                  {perfData.avgFillPrice !== null ? `${Math.round(perfData.avgFillPrice * 100)}¢` : "—"}
                </div>
                <div className="text-[9px] text-muted-foreground mt-0.5">winning side</div>
              </div>
            </div>

            {perfData.bySymbol.length > 0 && (
              <div className="bg-background/50 border border-border rounded-lg overflow-x-auto overscroll-x-contain">
                <table className="w-full min-w-[640px] text-sm">
                  <thead>
                    <tr className="text-left text-[10px] uppercase tracking-wide text-amber-500/70 border-b border-border/50 bg-amber-500/5">
                      <th className="px-4 py-2 font-bold">Coin</th>
                      <th className="px-4 py-2 font-bold">W / L</th>
                      <th className="px-4 py-2 font-bold">Win %</th>
                      <th className="px-4 py-2 font-bold">Net P&L</th>
                      <th className="px-4 py-2 font-bold">Spent</th>
                      <th className="px-4 py-2 font-bold">Avg fill</th>
                    </tr>
                  </thead>
                  <tbody>
                    {perfData.bySymbol.filter(s => s.orders > 0).map(row => (
                      <tr key={row.symbol} className="border-b border-border/40 hover:bg-muted/10 last:border-0">
                        <td className="px-4 py-2 font-bold text-xs">{row.symbol}</td>
                        <td className="px-4 py-2 text-xs text-muted-foreground">{row.wins} / {row.losses}</td>
                        <td className="px-4 py-2 text-xs text-emerald-400 font-medium">{row.winRate !== null ? `${Math.round(row.winRate * 100)}%` : "—"}</td>
                        <td className={`px-4 py-2 text-xs font-bold ${row.pnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                          {row.pnl > 0 ? "+" : ""}{fmt$(row.pnl)}
                        </td>
                        <td className="px-4 py-2 text-xs text-muted-foreground">{fmt$(row.spent)}</td>
                        <td className="px-4 py-2 text-xs font-mono">{row.avgFillPrice !== null ? `${Math.round(row.avgFillPrice * 100)}¢` : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        <div className="mt-4 pt-4 border-t border-border/30 text-right text-[10px] text-muted-foreground">
          Settings are written to the bot configuration and restored when the server restarts.
        </div>
      </div>
    </div>
    </div>
  );
}
