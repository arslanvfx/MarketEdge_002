export type Dashboard2DisplayState = "live" | "refreshing" | "previous_window" | "waiting";

export type Dashboard2MarketDisplaySnapshot = Readonly<{
  sourceWindowKey: string;
  ticker: string;
  target: number | null;
  side: "yes" | "no" | null;
  selectedAsk: number | null;
  yesAsk: number | null;
  noAsk: number | null;
  executableCost: number | null;
  visibleContracts: number;
  bookVersion: string;
  observedAt: number;
}>;

/**
 * Display continuity is deliberately separate from execution eligibility.
 * A retained snapshot keeps the dashboard legible, but can never be fed back
 * into the entry executor.
 */
export function retainDashboard2MarketDisplay(
  previous: Dashboard2MarketDisplaySnapshot | null,
  current: Dashboard2MarketDisplaySnapshot | null,
  currentWindowKey: string,
): { snapshot: Dashboard2MarketDisplaySnapshot | null; state: Dashboard2DisplayState } {
  if (current) return { snapshot: current, state: "live" };
  if (!previous) return { snapshot: null, state: "waiting" };
  return {
    snapshot: previous,
    state: previous.sourceWindowKey === currentWindowKey ? "refreshing" : "previous_window",
  };
}