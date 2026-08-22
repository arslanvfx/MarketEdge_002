import type { HistoryRecord, OpenPosition, ScalpOrder, ScalperAttempt } from "./types.ts";

export type ScalperLedger = {
  positions: OpenPosition[];
  history: HistoryRecord[];
};

type SettledScalpOutcome = "win" | "loss";
type DisplayScalpOutcome = SettledScalpOutcome | "open";

function displayOutcome(order: ScalpOrder): DisplayScalpOutcome | null {
  if (order.outcome === "open" || order.outcome === "win" || order.outcome === "loss") {
    return order.outcome;
  }
  if (order.outcome == null && order.settlementResult == null && order.settledAt == null) {
    return "open";
  }
  return null;
}

export function isConfirmedScalpFill(order: ScalpOrder): boolean {
  return (
    (order.status === "filled" || order.status === "paper")
    && Number.isFinite(order.filledCount)
    && order.filledCount > 0
    && order.avgFillPrice != null
    && Number.isFinite(order.avgFillPrice)
    && order.avgFillPrice > 0
    && order.avgFillPrice < 1
    && displayOutcome(order) != null
  );
}

function recordTimestamp(order: ScalpOrder): number {
  return new Date(order.settledAt ?? order.createdAt).getTime();
}

function preferOrder(current: ScalpOrder, candidate: ScalpOrder): ScalpOrder {
  const currentSettled = displayOutcome(current) !== "open";
  const candidateSettled = displayOutcome(candidate) !== "open";
  if (currentSettled !== candidateSettled) return candidateSettled ? candidate : current;
  return recordTimestamp(candidate) > recordTimestamp(current) ? candidate : current;
}

function toPosition(order: ScalpOrder): OpenPosition {
  return {
    id: `scalper:${order.id}`,
    symbol: order.symbol,
    windowKey: order.windowKey,
    ticker: order.ticker,
    direction: order.side,
    entryYesPrice: order.avgFillPrice!,
    contractCount: order.filledCount,
    betAmount: order.budgetSpent,
    kalshiTarget: 0,
    openedAt: new Date(order.createdAt).getTime(),
    cryptoPriceAtEntry: null,
    currentYesPrice: null,
    unrealizedPnl: null,
    guardStates: null,
    guardReason: null,
    source: "scalper",
    mode: order.mode,
    decisionMode: "scalper",
  };
}

function toHistory(order: ScalpOrder, outcome: DisplayScalpOutcome): HistoryRecord {
  return {
    id: `scalper:${order.id}`,
    symbol: order.symbol,
    windowKey: order.windowKey,
    ticker: order.ticker,
    direction: order.side,
    action: outcome === "open" ? "bet" : "expired",
    mode: order.mode,
    signals: {
      scalper: true,
      status: order.status,
      incidentId: order.incidentId,
      orderId: order.orderId,
      settlementResult: order.settlementResult,
    },
    entryPrice: String(order.avgFillPrice),
    exitPrice: null,
    contractCount: order.filledCount,
    betAmount: String(order.budgetSpent),
    pnl: order.pnl == null ? null : String(order.pnl),
    exitReason: null,
    phase2Activated: false,
    outcome: outcome === "open" ? null : outcome,
    kalshiTarget: null,
    cryptoPriceAtEntry: null,
    cryptoPriceAtExit: null,
    createdAt: order.createdAt,
    exitedAt: outcome === "open" ? null : order.settledAt,
    decisionMode: "scalper",
    source: "scalper",
    entryYesPrice: String(order.avgFillPrice),
  };
}

export function normalizeScalpOrders(
  orders: readonly ScalpOrder[],
  mode?: "paper" | "live",
): ScalperLedger {
  const byId = new Map<string, ScalpOrder>();
  for (const order of orders) {
    if (mode && order.mode !== mode) continue;
    if (!isConfirmedScalpFill(order)) continue;
    const current = byId.get(order.id);
    byId.set(order.id, current ? preferOrder(current, order) : order);
  }

  const confirmed = [...byId.values()].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
  const positions: OpenPosition[] = [];
  const history: HistoryRecord[] = [];
  for (const order of confirmed) {
    const outcome = displayOutcome(order);
    if (!outcome) continue;
    history.push(toHistory(order, outcome));
    if (outcome === "open") positions.push(toPosition(order));
  }
  return { positions, history };
}

export function describeScalperAttempt(attempt: ScalperAttempt): string {
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

export function describeScalperEvidence(attempt: ScalperAttempt): string[] {
  const evidence = attempt.skipEvidence;
  if (!evidence) return [];
  const details: string[] = [];

  if (evidence.distancePct != null || evidence.minimumPct != null) {
    const measured = evidence.distancePct == null ? "unavailable" : `${evidence.distancePct.toFixed(3)}%`;
    const minimum = evidence.minimumPct == null ? "not configured" : `${evidence.minimumPct.toFixed(3)}% minimum`;
    const prices = evidence.targetPrice != null && evidence.underlyingPrice != null
      ? ` · target ${formatUnderlyingPrice(evidence.targetPrice)}, underlying ${formatUnderlyingPrice(evidence.underlyingPrice)}`
      : "";
    details.push(`Target distance ${measured} (${minimum})${prices}`);
  }

  if (
    evidence.adverseMovePct != null
    || evidence.freefallThresholdPct != null
    || evidence.samplesUsed != null
  ) {
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

  if (evidence.quoteYesAsk != null || evidence.quoteNoAsk != null) {
    const asks = [
      evidence.quoteYesAsk == null ? null : `YES ${(evidence.quoteYesAsk * 100).toFixed(1)}¢`,
      evidence.quoteNoAsk == null ? null : `NO ${(evidence.quoteNoAsk * 100).toFixed(1)}¢`,
    ].filter(Boolean).join(" / ");
    const band = evidence.bandMin != null && evidence.bandMax != null
      ? ` · permitted winning cost ${(evidence.bandMin * 100).toFixed(1)}–${(evidence.bandMax * 100).toFixed(1)}¢`
      : "";
    details.push(`Authenticated final quote ${asks}${band}`);
  }

  if (evidence.requestedBudget != null) {
    const cap = evidence.dailyCapDollars != null
      ? `daily ${formatMoney(evidence.dailyCommittedDollars)} of ${formatMoney(evidence.dailyCapDollars)}`
      : evidence.openCapDollars != null
        ? `open ${formatMoney(evidence.openCommittedDollars)} of ${formatMoney(evidence.openCapDollars)}`
        : "cap details unavailable";
    details.push(`Requested ${formatMoney(evidence.requestedBudget)} · ${cap}`);
  }

  if (evidence.availableBalance != null || evidence.maxExposure != null) {
    details.push(
      `Available balance ${formatMoney(evidence.availableBalance)} · required exposure ${formatMoney(evidence.maxExposure)}`,
    );
  }

  if (evidence.secondsRemaining != null || evidence.effectiveWindowSeconds != null) {
    const remaining = evidence.secondsRemaining == null
      ? "close time unavailable"
      : evidence.secondsRemaining > 0
        ? `${Math.max(0, evidence.secondsRemaining).toFixed(1)}s remained`
        : `closed ${Math.abs(evidence.secondsRemaining).toFixed(1)}s earlier`;
    const window = evidence.effectiveWindowSeconds == null
      ? ""
      : ` · ${evidence.effectiveWindowSeconds}s effective entry window`;
    details.push(`${remaining}${window}`);
  }

  const latencyParts = [
    evidence.identityRefreshMs == null ? null : `identity ${evidence.identityRefreshMs}ms`,
    evidence.quoteRefreshMs == null ? null : `quote ${evidence.quoteRefreshMs}ms`,
    evidence.parallelRefreshMs == null ? null : `parallel total ${evidence.parallelRefreshMs}ms`,
  ].filter(Boolean);
  if (latencyParts.length > 0) details.push(`Final refresh latency: ${latencyParts.join(" · ")}`);

  return details;
}

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