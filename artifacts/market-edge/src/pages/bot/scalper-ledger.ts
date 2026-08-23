import type { EntryGuardEvidence, HistoryRecord, OpenPosition, ScalpOrder, ScalperAttempt } from "./types.ts";

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
      entryGuardEvidence: order.entryGuardEvidence ?? null,
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
  if (attempt.status === "error") return attempt.reason ? `Error — ${describeScalperReason(attempt.reason)}` : "Attempt failed";
  const guardBlock = getScalperGuardBlock(attempt);
  if (guardBlock && attempt.reason) return `${guardBlock.label}: ${describeScalperReason(attempt.reason)}`;
  if (attempt.reason === "second_quote_outside_band" || attempt.reason === "final_quote_outside_band") {
    return "Final price was outside your entry range";
  }
  if (attempt.reason === "first_quote_outside_band") return "Current price was outside your entry range";
  if (attempt.status === "claimed") return "Checks in progress";
  return attempt.reason ? describeScalperReason(attempt.reason) : "Skipped before order";
}

export function describeEntryGuardEvidence(ege: EntryGuardEvidence): string[] {
  const lines: string[] = [];

  const evaluatedAt = new Date(ege.evaluatedAt);
  const evaluatedAtText = Number.isNaN(evaluatedAt.getTime())
    ? ege.evaluatedAt
    : evaluatedAt.toISOString();
  lines.push(
    `SAFETY CHECKS PASSED — final pre-submit snapshot evaluated ${evaluatedAtText} (samples exclude post-fill movement)`,
  );

  // Sample prices/timestamps
  if (ege.samples.length > 0) {
    const sampleDesc = ege.samples
      .map((s) => {
        const at = new Date(s.at);
        const atText = Number.isNaN(at.getTime()) ? s.at : at.toISOString();
        return `${formatUnderlyingPrice(s.price)} @ ${atText}`;
      })
      .join(", ");
    const coverageText = ege.sampleCoverageMs == null
      ? ""
      : ` · ${(ege.sampleCoverageMs / 1_000).toFixed(1)}s coverage`;
    lines.push(`Samples (${ege.samplesUsed ?? ege.samples.length}): ${sampleDesc}${coverageText}`);
  }

  // Wrong-way resets / streak duration
  const resetCount = ege.wrongWayResetCount;
  const lastReset = ege.lastWrongWayResetAt;
  const wrongWayMoves = ege.consecutiveWrongWayMoves;
  const wrongWaySecs = ege.consecutiveWrongWaySeconds;
  const threshold = ege.freefallConsecutiveSeconds;
  if (ege.directionGuardEnabled) {
    const resetText = resetCount == null
      ? "resets unavailable"
      : resetCount === 0
        ? "no wrong-way resets"
        : `${resetCount} wrong-way reset${resetCount === 1 ? "" : "s"}${
            lastReset
              ? ` (last ${
                  Number.isNaN(new Date(lastReset).getTime())
                    ? lastReset
                    : new Date(lastReset).toISOString()
                })`
              : ""
          }`;
    const streakText = wrongWaySecs != null
      ? `${wrongWaySecs.toFixed(1)}s consecutive wrong-way`
      : wrongWayMoves != null
        ? `${wrongWayMoves} consecutive wrong-way moves`
        : "streak unavailable";
    const thresholdText = threshold != null ? ` · ${threshold}s threshold` : "";
    lines.push(`Direction guard: ${resetText} · ${streakText}${thresholdText} — CLEAR`);
  } else {
    lines.push("Direction guard: disabled for this entry");
  }

  // Directional movement + active duration
  if (ege.directionGuardEnabled && ege.directionalMovePct != null) {
    const movePct = `${ege.directionalMovePct >= 0 ? "+" : ""}${ege.directionalMovePct.toFixed(3)}%`;
    const wrongWay = ege.side === "yes"
      ? ege.directionalMovePct < 0
      : ege.directionalMovePct > 0;
    const disposition = ege.directionalMovePct === 0
      ? "flat"
      : wrongWay
        ? "wrong-way toward target"
        : "favorable away from target";
    lines.push(
      `Directional movement ${movePct} — ${disposition} for ${ege.side.toUpperCase()} entry; duration stayed below the blocking threshold — CLEAR`,
    );
  }

  if (ege.directionGuardEnabled && ege.favorableTrendConfirmationEnabled) {
    const moveText = ege.directionalMovePct == null
      ? "net movement unavailable"
      : `${ege.directionalMovePct >= 0 ? "+" : ""}${ege.directionalMovePct.toFixed(3)}% net`;
    if (ege.favorableTrendConfirmed === true) {
      lines.push(
        `Favorable-trend confirmation: ${moveText} — net favorable trend confirmed for ${ege.side.toUpperCase()} — CLEAR`,
      );
    } else {
      lines.push(
        `Favorable-trend confirmation: ${moveText} — ${ege.favorableTrendReason ?? "confirmation unavailable"}`,
      );
    }
    const targetDirection = ege.side === "yes" ? "above" : "below";
    if (ege.targetSideWindowConfirmed === true) {
      lines.push(
        `Full-window target side: every sample stayed ${targetDirection} the target — CLEAR`,
      );
    } else if (ege.targetSideWindowConfirmed === false) {
      const violation = ege.targetSideViolationPrice == null
        ? "violating sample unavailable"
        : `${formatUnderlyingPrice(ege.targetSideViolationPrice)}${
            ege.targetSideViolationAt ? ` @ ${ege.targetSideViolationAt}` : ""
          }`;
      lines.push(
        `Full-window target side: ${violation} did not stay ${targetDirection} the target`,
      );
    }
  } else if (ege.directionGuardEnabled) {
    lines.push("Favorable-trend confirmation: disabled for this entry");
  }

  if (
    ege.directionGuardEnabled
    && ege.favorableTrendConfirmationEnabled
    && ege.coordinatedDirectionClearanceEnabled
  ) {
    const projectedPrice = ege.projectedPrice == null
      ? "projected price unavailable"
      : `projected ${formatUnderlyingPrice(ege.projectedPrice)} at close`;
    const projectedDistance = ege.projectedDistancePct == null
      ? "buffer unavailable"
      : `${ege.projectedDistancePct.toFixed(3)}% projected target buffer`;
    const minimum = ege.minimumPct == null
      ? "minimum unavailable"
      : `${ege.minimumPct.toFixed(3)}% minimum`;
    if (ege.coordinatedDirectionClearanceApplied) {
      lines.push(
        `Coordinated clearance: ALLOWED — ${projectedPrice} · ${projectedDistance} (${minimum})`,
      );
    } else if (ege.favorableTrendConfirmed === true) {
      lines.push("Coordinated clearance: not needed because the full-window trend was favorable");
    } else {
      lines.push(
        `Coordinated clearance: ${ege.coordinatedDirectionClearanceReason ?? "not available"} · ${projectedPrice} · ${projectedDistance} (${minimum})`,
      );
    }
  }

  // Rapid measurement + threshold
  if (ege.rapidMoveGuardEnabled) {
    const rapidMeasured = ege.rapidMovePct == null ? "unavailable" : `${ege.rapidMovePct.toFixed(3)}%`;
    const rapidThreshold = ege.rapidMoveThresholdPct == null ? "threshold unavailable" : `${ege.rapidMoveThresholdPct.toFixed(3)}% threshold`;
    const rapidInterval = ege.rapidMoveLookbackSeconds == null ? "" : ` over ${ege.rapidMoveLookbackSeconds}s`;
    lines.push(`Fast-move: ${rapidMeasured}${rapidInterval} (${rapidThreshold}) — CLEAR`);
  } else {
    lines.push("Fast-move guard: disabled for this entry");
  }

  // Target distance + minimum
  if (ege.targetProximityGuardEnabled) {
    const distMeasured = ege.distancePct == null ? "unavailable" : `${ege.distancePct.toFixed(3)}%`;
    const distMinimum = ege.minimumPct == null ? "minimum unavailable" : `${ege.minimumPct.toFixed(3)}% minimum`;
    const priceText = ege.targetPrice != null && ege.underlyingPrice != null
      ? ` · target ${formatUnderlyingPrice(ege.targetPrice)}, underlying ${formatUnderlyingPrice(ege.underlyingPrice)}`
      : "";
    lines.push(`Target distance ${distMeasured} (${distMinimum})${priceText} — CLEAR`);
  } else {
    lines.push("Target-distance guard: disabled for this entry");
  }

  return lines;
}

export function describeScalperEvidence(attempt: ScalperAttempt): string[] {
  const evidence = attempt.skipEvidence;
  const details: string[] = [];
  const guardBlock = getScalperGuardBlock(attempt);

  // For filled/submitted attempts with entry guard evidence, show the SAFETY CHECKS PASSED block
  if (
    (
      attempt.status === "filled"
      || attempt.status === "claimed"
      || attempt.status === "zero_fill"
      || attempt.status === "unknown"
    )
    && attempt.entryGuardEvidence != null
  ) {
    details.push(...describeEntryGuardEvidence(attempt.entryGuardEvidence));
    // Still show latency below if available; return early from guard-block logic
    details.push(...describeAttemptLatency(attempt));
    return details;
  }

  if (guardBlock && attempt.reason) {
    details.push(`GUARD TRIGGERED: ${guardBlock.label} — ${describeScalperReason(attempt.reason)}`);
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
    const resetText = evidence.wrongWayResetCount == null
      ? ""
      : evidence.wrongWayResetCount === 0
        ? " · no wrong-way resets"
        : ` · ${evidence.wrongWayResetCount} wrong-way reset${
            evidence.wrongWayResetCount === 1 ? "" : "s"
          }${
            evidence.lastWrongWayResetAt
              ? ` (last ${evidence.lastWrongWayResetAt})`
              : ""
          }`;
    details.push(`Real-time direction ${movement} · ${streak}${resetText}${sampleText}${sideText}`);
  }

  if (evidence?.favorableTrendConfirmationEnabled) {
    const movement = evidence.directionalMovePct == null
      ? "movement unavailable"
      : `${evidence.directionalMovePct >= 0 ? "+" : ""}${evidence.directionalMovePct.toFixed(3)}%`;
    const disposition = evidence.favorableTrendConfirmed
      ? "CONFIRMED"
      : "BLOCKED";
    const reason = evidence.favorableTrendReason
      ? ` · ${describeScalperReason(evidence.favorableTrendReason)}`
      : "";
    details.push(`Full-window favorable trend ${disposition}: ${movement}${reason}`);
    const targetDirection = evidence.protectedSide === "no" ? "below" : "above";
    if (evidence.targetSideWindowConfirmed != null) {
      const targetDisposition = evidence.targetSideWindowConfirmed
        ? "CONFIRMED"
        : "BLOCKED";
      const violation = evidence.targetSideWindowConfirmed
        || evidence.targetSideViolationPrice == null
        ? ""
        : ` · first violation ${formatUnderlyingPrice(
            evidence.targetSideViolationPrice,
          )}${
            evidence.targetSideViolationAt
              ? ` @ ${evidence.targetSideViolationAt}`
              : ""
          }`;
      details.push(
        `Full-window target side ${targetDisposition}: every sample must stay ${targetDirection} target${violation}`,
      );
    }
  }

  if (
    evidence?.coordinatedDirectionClearanceEnabled
    || attempt.reason?.startsWith("coordinated_direction_clearance_")
  ) {
    const status = evidence?.coordinatedDirectionClearanceApplied
      ? "ALLOWED"
      : "BLOCKED";
    const projectedPrice = evidence?.projectedPrice == null
      ? "projected price unavailable"
      : `projected ${formatUnderlyingPrice(evidence.projectedPrice)} at close`;
    const projectedDistance = evidence?.projectedDistancePct == null
      ? "buffer unavailable"
      : `${evidence.projectedDistancePct.toFixed(3)}% projected target buffer`;
    const minimum = evidence?.minimumPct == null
      ? "minimum unavailable"
      : `${evidence.minimumPct.toFixed(3)}% minimum`;
    const reason = evidence?.coordinatedDirectionClearanceReason
      ? ` · ${describeScalperReason(evidence.coordinatedDirectionClearanceReason)}`
      : "";
    details.push(
      `Coordinated direction clearance ${status}: ${projectedPrice} · ${projectedDistance} (${minimum})${reason}`,
    );
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

  details.push(...describeAttemptLatency(attempt));

  return details;
}

export function getScalperGuardBlock(attempt: ScalperAttempt): ScalperGuardBlock | null {
  if (attempt.status !== "skipped" || !attempt.reason) return null;
  const reason = normalizeReason(attempt.reason);

  if (
    reason.startsWith("freefall_consecutive_")
    || reason.startsWith("freefall_favorable_trend_")
    || reason.startsWith("freefall_wrong_target_side_")
    || reason.startsWith("freefall_unavailable_")
    || reason.startsWith("coordinated_direction_clearance_")
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
  outside_window_at_claim: "Not enough time remained in this window",
  window_expired_before_submit: "The window closed before we could place the order",
  outside_window_before_submit: "Not enough time remained to safely place the order",
  outside_window_second_quote: "The window closed while we checked the final price",
  identity_outside_window: "The market changed too close to the end of the window",
  identity_refresh_failed: "We could not confirm the current market before entry",
  identity_missing_after_refresh: "The current market was not available before entry",
  identity_changed: "The market changed while we were checking it",
  identity_changed_before_submit: "The market changed before we could place the order",
  identity_missing_before_submit: "The market was no longer available before entry",
  final_quote_invalid: "No valid price was available at the final check",
  final_quote_outside_band: "Final price was outside your entry range",
  side_flipped_final_quote: "The final price qualified on the other side of the market",
  target_proximity_too_close: "The underlying price was too close to the target",
  target_proximity_unavailable_no_product: "We could not verify the distance from the target",
  target_proximity_unavailable_fetch_failed: "We could not get a fresh underlying price to check the target distance",
  freefall_adverse_falling: "Price fell too quickly toward the target",
  freefall_adverse_rising: "Price rose too quickly toward the target",
  freefall_adverse_reversal_falling: "Price reversed downward too quickly toward the target",
  freefall_adverse_reversal_rising: "Price reversed upward too quickly toward the target",
  freefall_consecutive_falling: "Price kept falling toward the target for too long",
  freefall_consecutive_rising: "Price kept rising toward the target for too long",
  freefall_wrong_target_side_yes: "At least one recent price was not above the target for a YES entry",
  freefall_wrong_target_side_no: "At least one recent price was not below the target for a NO entry",
  freefall_favorable_trend_not_confirmed_yes: "Recent prices did not show an upward trend for a YES entry",
  freefall_favorable_trend_not_confirmed_no: "Recent prices did not show a downward trend for a NO entry",
  coordinated_direction_clearance_requires_target_guard: "The target-distance check must be enabled before a directional clearance can be granted",
  coordinated_direction_clearance_unavailable: "There was not enough reliable timing or distance information to grant a directional clearance",
  coordinated_direction_clearance_projected_too_close_yes: "At the current downward pace, price could get too close to the target before the YES market closes",
  coordinated_direction_clearance_projected_too_close_no: "At the current upward pace, price could get too close to the target before the NO market closes",
  coordinated_direction_clearance_safe_yes: "The projected price remains safely above the target through close",
  coordinated_direction_clearance_safe_no: "The projected price remains safely below the target through close",
  freefall_unavailable_no_samples: "We did not have enough fresh prices to make this safety check",
  freefall_unavailable_warming: "The direction check is still collecting recent prices",
  freefall_unavailable_sample_gap: "A required price update was missed, so we did not enter",
  freefall_unavailable_coverage: "Recent prices did not cover enough time for a safe check",
  freefall_unavailable_stale: "Recent prices were too old for a safe entry",
  freefall_unavailable_fetch_failed: "We could not get a fresh price for the safety check",
  freefall_unavailable_no_product: "The underlying market was unavailable for the safety check",
  freefall_unavailable_out_of_order: "Recent price updates arrived out of order",
  freefall_unavailable_target: "The current target was unavailable for the safety check",
  rapid_move_too_fast_rising: "Price was rising too quickly to enter safely",
  rapid_move_too_fast_falling: "Price was falling too quickly to enter safely",
  rapid_move_unavailable_warming: "The fast-move check is still collecting recent prices",
  rapid_move_unavailable_sample_gap: "A required price update was missed during the fast-move check",
  final_balance_check_failed: "We could not confirm enough available balance before entry",
  balance_check_failed_final: "We could not confirm enough available balance before entry",
  insufficient_balance_final: "Available balance was too low for this order",
  breaker_before_submit: "The circuit breaker paused new entries",
  opposite_regular_position: "This trade would conflict with an open regular position",
};

export function describeScalperReason(reason: string): string {
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

function describeAttemptLatency(attempt: ScalperAttempt): string[] {
  const latency = attempt.latency;
  if (!latency) return [];
  const slowest = latency.slowestStage == null
    ? "stage unavailable"
    : `${latency.slowestStage.replaceAll("_", " ")} ${formatLatency(latency.slowestStageMs)}`;
  const stages = [
    latency.queueWaitMs == null ? null : `queue ${formatLatency(latency.queueWaitMs)}`,
    latency.capClaimMs == null ? null : `cap ${formatLatency(latency.capClaimMs)}`,
    latency.parallelRefreshMs == null ? null : `parallel refresh ${formatLatency(latency.parallelRefreshMs)}`,
    latency.identityRefreshMs == null ? null : `identity ${formatLatency(latency.identityRefreshMs)}`,
    latency.quoteRefreshMs == null ? null : `first quote ${formatLatency(latency.quoteRefreshMs)}`,
    latency.finalRequoteMs == null ? null : `final quote ${formatLatency(latency.finalRequoteMs)}`,
    latency.intentWriteMs == null ? null : `intent ${formatLatency(latency.intentWriteMs)}`,
    latency.brokerSubmitMs == null ? null : `broker ${formatLatency(latency.brokerSubmitMs)}`,
    latency.decisionFinalizeMs == null ? null : `finalize ${formatLatency(latency.decisionFinalizeMs)}`,
  ].filter((stage): stage is string => stage != null);
  const windowBudget = latency.windowRemainingAtDetectedMs;
  const budgetLine = latency.windowExpiredDuringAttempt
    ? `LATENCY WARNING: market closed during this attempt; slowest stage was ${slowest}`
    : windowBudget != null && windowBudget > 0
      ? `Window budget used: ${Math.min(999, (latency.totalMs / windowBudget) * 100).toFixed(1)}% of ${formatLatency(windowBudget)} remaining at detection`
      : null;
  return [
    `Fast path ${formatLatency(latency.totalMs)} total · slowest ${slowest}`,
    budgetLine,
    stages.length > 0 ? `Timing stages: ${stages.join(" · ")}` : "",
  ].filter((line): line is string => line != null && line !== "");
}