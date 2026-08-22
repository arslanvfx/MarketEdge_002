import type {
  ScalpMode,
  ScalpOrder,
  ScalpPerformance,
} from "./kalshi-scalper-types.ts";

/**
 * Pure reporting calculation. Filtering is repeated here even though the DB
 * query is already scoped, keeping entry-time semantics fail-safe and testable.
 */
export function calculateScalpPerformance(
  mode: ScalpMode,
  trackingSince: Date,
  trackingVersion: number,
  orders: ScalpOrder[],
): ScalpPerformance {
  const baselineMs = trackingSince.getTime();
  if (!Number.isFinite(baselineMs)) {
    throw new Error("Invalid Scalper performance baseline");
  }

  const eligible = orders.filter(
    (order) => order.mode === mode && order.createdAt.getTime() >= baselineMs,
  );
  const filled = eligible.filter((order) => order.filledCount > 0);
  const settled = filled.filter((order) => order.outcome != null);
  const wins = settled.filter((order) => order.outcome === "win").length;
  const losses = settled.filter((order) => order.outcome === "loss").length;
  const totalPnl = settled.reduce((sum, order) => sum + (order.pnl ?? 0), 0);
  const totalSpent = filled.reduce((sum, order) => sum + order.budgetSpent, 0);
  const fillPrices = filled
    .filter((order) => order.avgFillPrice != null)
    .map((order) => order.avgFillPrice!);
  const avgFillPrice = fillPrices.length > 0
    ? fillPrices.reduce((sum, price) => sum + price, 0) / fillPrices.length
    : null;

  const bySymbolMap = new Map<string, {
    orders: number;
    wins: number;
    losses: number;
    settled: number;
    pnl: number;
    spent: number;
    fillPrices: number[];
  }>();

  for (const order of filled) {
    const stats = bySymbolMap.get(order.symbol) ?? {
      orders: 0,
      wins: 0,
      losses: 0,
      settled: 0,
      pnl: 0,
      spent: 0,
      fillPrices: [],
    };
    stats.orders++;
    stats.spent += order.budgetSpent;
    if (order.avgFillPrice != null) stats.fillPrices.push(order.avgFillPrice);
    if (order.outcome === "win") {
      stats.wins++;
      stats.settled++;
      stats.pnl += order.pnl ?? 0;
    } else if (order.outcome === "loss") {
      stats.losses++;
      stats.settled++;
      stats.pnl += order.pnl ?? 0;
    }
    bySymbolMap.set(order.symbol, stats);
  }

  const bySymbol = Array.from(bySymbolMap.entries()).map(([symbol, stats]) => ({
    symbol,
    orders: stats.orders,
    wins: stats.wins,
    losses: stats.losses,
    settled: stats.settled,
    winRate: stats.wins + stats.losses > 0
      ? stats.wins / (stats.wins + stats.losses)
      : null,
    pnl: stats.pnl,
    spent: stats.spent,
    avgFillPrice: stats.fillPrices.length > 0
      ? stats.fillPrices.reduce((sum, price) => sum + price, 0) / stats.fillPrices.length
      : null,
  }));

  return {
    mode,
    trackingSince: trackingSince.toISOString(),
    trackingVersion,
    totalOrders: eligible.length,
    filledOrders: filled.length,
    settled: settled.length,
    wins,
    losses,
    winRate: wins + losses > 0 ? wins / (wins + losses) : null,
    totalPnl,
    totalSpent,
    avgFillPrice,
    bySymbol,
  };
}