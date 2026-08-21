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
  if (attempt.reason === "second_quote_outside_band") return "Final authenticated quote moved outside the band";
  if (attempt.reason === "first_quote_outside_band") return "Preliminary quote was outside the band";
  if (attempt.status === "claimed") return "Checks in progress";
  return attempt.reason ? humanizeReason(attempt.reason) : "Skipped before order";
}

function humanizeReason(reason: string): string {
  return reason
    .replace(/\s*\([^)]*\)\s*$/, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}