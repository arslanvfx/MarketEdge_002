import type { HistoryRecord, OpenPosition, ScalpOrder, ScalperAttempt } from "./types.ts";

export type ScalperLedger = {
  positions: OpenPosition[];
  history: HistoryRecord[];
};

export type ScalperGuardBlock = {
  key: "direction" | "freefall" | "fast_move" | "target" | "breaker" | "balance" | "position";
  label: string;
  badge: string;
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
      layeredRegularPositionId: order.layeredRegularPositionId,
      layeredRegularSide: order.layeredRegularSide,
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
  if (attempt.status === "filled") {
    return attempt.layeredRegularSide
      ? `Confirmed fill — layered on regular ${attempt.layeredRegularSide.toUpperCase()}`
      : "Confirmed fill";
  }
  if (attempt.status === "zero_fill") return "IOC returned zero fills";
  if (attempt.status === "unknown") return "Order result unknown — reconciliation required";
  if (attempt.status === "error") return attempt.reason ? `Error — ${humanizeReason(attempt.reason)}` : "Attempt failed";
  const guardBlock = getScalperGuardBlock(attempt);
  if (guardBlock) return `${guardBlock.label} blocked submission`;
  if (attempt.reason === "second_quote_outside_band" || attempt.reason === "final_quote_outside_band") {
    return "Final authenticated quote moved outside the permitted band";
  }
  if (attempt.reason === "first_quote_outside_band") return "Preliminary quote was outside the band";
  if (attempt.status === "claimed") return "Checks in progress";
  return attempt.reason ? humanizeReason(attempt.reason) : "Skipped before order";
}

export function describeScalperEvidence(attempt: ScalperAttempt): string[] {
  const evidence = attempt.skipEvidence;
  const details: string[] = [];
  const guardBlock = getScalperGuardBlock(attempt);

  if (guardBlock && attempt.reason) {
    details.push(`GUARD TRIGGERED: ${guardBlock.label} — ${humanizeReason(attempt.reason)}`);
  }

  if (
    evidence?.layerDecision === "opposite_side_block"
    && evidence.selectedSide
    && evidence.regularPositionSide
  ) {
    details.push(
      `Blocked: Scalper ${evidence.selectedSide.toUpperCase()} would oppose open regular ${evidence.regularPositionSide.toUpperCase()}`,
    );
  }

  if (evidence && (evidence.distancePct != null || evidence.minimumPct != null)) {
    const measured = evidence.distancePct == null ? "unavailable" : `${evidence.distancePct.toFixed(3)}%`;
    const minimum = evidence.minimumPct == null ? "not configured" : `${evidence.minimumPct.toFixed(3)}% minimum`;
    const prices = evidence.targetPrice != null && evidence.underlyingPrice != null
      ? ` · target ${formatUnderlyingPrice(evidence.targetPrice)}, underlying ${formatUnderlyingPrice(evidence.underlyingPrice)}`
      : "";
    details.push(`Target distance ${measured} (${minimum})${prices}`);
  }

  if (evidence && (
    evidence.directionalMovePct != null
    || evidence.freefallConsecutiveSeconds != null
    || evidence.consecutiveWrongWaySeconds != null
    || evidence.consecutiveWrongWayMoves != null
    || evidence.samplesUsed != null
  )) {
    const movement = evidence.directionalMovePct == null
      ? "movement unavailable"
      : `${evidence.directionalMovePct >= 0 ? "+" : ""}${evidence.directionalMovePct.toFixed(3)}%`;
    const wrongWaySeconds =
      evidence.consecutiveWrongWaySeconds
      ?? evidence.consecutiveWrongWayMoves;
    const wrongWaySecondsText = wrongWaySeconds == null
      ? null
      : Number.isInteger(wrongWaySeconds)
        ? String(wrongWaySeconds)
        : wrongWaySeconds.toFixed(1);
    const streak = wrongWaySeconds == null
      ? "streak unavailable"
      : `${wrongWaySecondsText}/${evidence.freefallConsecutiveSeconds ?? "?"} wrong-way seconds`;
    const sampleText = evidence.samplesUsed == null
      ? ""
      : ` · ${evidence.samplesUsed} sample${evidence.samplesUsed === 1 ? "" : "s"}${
          evidence.sampleCoverageMs == null ? "" : ` over ${(evidence.sampleCoverageMs / 1_000).toFixed(1)}s`
        }`;
    const sideText = evidence.protectedSide ? ` · protected ${evidence.protectedSide.toUpperCase()}` : "";
    details.push(`Real-time direction ${movement} · ${streak}${sampleText}${sideText}`);
  }

  if (evidence && (
    evidence.rapidMoveBlocked != null
    || evidence.rapidMovePct != null
    || evidence.rapidMoveThresholdPct != null
  )) {
    const measured = evidence.rapidMovePct == null
      ? "unavailable"
      : `${evidence.rapidMovePct.toFixed(3)}%`;
    const threshold = evidence.rapidMoveThresholdPct == null
      ? "threshold unavailable"
      : `${evidence.rapidMoveThresholdPct.toFixed(3)}% threshold`;
    const interval = evidence.rapidMoveLookbackSeconds == null
      ? ""
      : ` over ${evidence.rapidMoveLookbackSeconds}s`;
    const disposition = evidence.rapidMoveBlocked || attempt.reason?.startsWith("rapid_move_")
      ? "BLOCKED"
      : "clear";
    details.push(`Fast-move guard ${disposition}: ${measured}${interval} (${threshold})`);
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
      evidence.openCapDollars == null
        ? null
        : `open ${formatMoney(evidence.openCommittedDollars)} of ${formatMoney(evidence.openCapDollars)}`,
      evidence.dailyCapDollars == null
        ? null
        : `daily ${formatMoney(evidence.dailyCommittedDollars)} of ${formatMoney(evidence.dailyCapDollars)}`,
    ].filter(Boolean).join(" · ");
    details.push(`Requested ${formatMoney(evidence.requestedBudget)} · ${capDetails || "cap details unavailable"}`);
  }

  if (evidence && (evidence.availableBalance != null || evidence.maxExposure != null)) {
    details.push(
      `Available balance ${formatMoney(evidence.availableBalance)} · required exposure ${formatMoney(evidence.maxExposure)}`,
    );
  }

  if (evidence && (evidence.secondsRemaining != null || evidence.effectiveWindowSeconds != null)) {
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

export function getScalperGuardBlock(attempt: ScalperAttempt): ScalperGuardBlock | null {
  if (attempt.status !== "skipped" || !attempt.reason) return null;
  const reason = normalizeReason(attempt.reason);

  if (
    reason.startsWith("freefall_consecutive_")
    || reason.startsWith("freefall_wrong_target_side_")
    || reason.startsWith("freefall_unavailable_")
  ) {
    return {
      key: "direction",
      label: "Real-Time Direction Guard",
      badge: "DIRECTION GUARD",
    };
  }
  if (reason.startsWith("freefall_")) {
    return {
      key: "freefall",
      label: "Freefall Guard",
      badge: "FREEFALL GUARD",
    };
  }
  if (reason.startsWith("rapid_move_")) {
    return {
      key: "fast_move",
      label: "Fast-Move Guard",
      badge: "FAST-MOVE GUARD",
    };
  }
  if (reason.startsWith("target_proximity_")) {
    return {
      key: "target",
      label: "Target-Proximity Guard",
      badge: "TARGET GUARD",
    };
  }
  if (reason === "breaker_before_submit") {
    return {
      key: "breaker",
      label: "Circuit Breaker",
      badge: "CIRCUIT BREAKER",
    };
  }
  if (
    reason === "final_balance_check_failed"
    || reason === "balance_check_failed_final"
    || reason === "insufficient_balance_final"
  ) {
    return {
      key: "balance",
      label: "Balance / Exposure Guard",
      badge: "BALANCE GUARD",
    };
  }
  if (reason === "opposite_regular_position") {
    return {
      key: "position",
      label: "Position-Side Guard",
      badge: "POSITION GUARD",
    };
  }
  return null;
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
  freefall_consecutive_falling: "Underlying fell toward the target for the configured consecutive seconds",
  freefall_consecutive_rising: "Underlying rose toward the target for the configured consecutive seconds",
  freefall_wrong_target_side_yes: "Underlying was not above the target for the YES entry",
  freefall_wrong_target_side_no: "Underlying was not below the target for the NO entry",
  freefall_unavailable_no_samples: "Freefall guard lacked enough fresh samples",
  freefall_unavailable_warming: "Real-time direction guard is collecting its required one-second samples",
  freefall_unavailable_sample_gap: "A one-second underlying-price tick was missed",
  freefall_unavailable_coverage: "Freefall samples did not cover enough of the lookback",
  freefall_unavailable_stale: "Freefall samples were stale",
  freefall_unavailable_fetch_failed: "Fresh underlying price fetch failed — Freefall blocked submission",
  freefall_unavailable_no_product: "Underlying product was unavailable — Freefall blocked submission",
  freefall_unavailable_out_of_order: "Freefall samples arrived out of order",
  freefall_unavailable_target: "The active Kalshi target was unavailable",
  rapid_move_too_fast_rising: "Fast-move avoidance blocked an unusually rapid rise",
  rapid_move_too_fast_falling: "Fast-move avoidance blocked an unusually rapid fall",
  rapid_move_unavailable_warming: "Fast-move avoidance is collecting its required samples",
  rapid_move_unavailable_sample_gap: "Fast-move avoidance missed a one-second price tick",
  final_balance_check_failed: "Final balance check failed",
  balance_check_failed_final: "Final balance check failed",
  insufficient_balance_final: "Available balance was below worst-case exposure",
  breaker_before_submit: "Circuit breaker blocked submission",
  opposite_regular_position: "Opposite regular position blocked submission",
};

function humanizeReason(reason: string): string {
  const clean = normalizeReason(reason);
  return REASON_LABELS[clean] ?? clean
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function normalizeReason(reason: string): string {
  return reason.replace(/^aborted_before_submit:/, "").replace(/\s*\([^)]*\)\s*$/, "");
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