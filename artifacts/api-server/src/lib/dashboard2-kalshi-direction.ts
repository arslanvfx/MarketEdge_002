import type { KalshiTopOfBook } from "./kalshi-orderbook-store.ts";

function distanceFromBand(cost: number, floor: number, ceiling: number): number {
  return cost < floor ? floor - cost : cost > ceiling ? cost - ceiling : 0;
}

export function selectDashboard2KalshiDirection(
  snapshot: KalshiTopOfBook | null,
  floor: number,
  ceiling: number,
  allowNearest = false,
): { side: "yes" | "no"; ask: number; snapshot: KalshiTopOfBook } | null {
  if (!snapshot) return null;
  const candidates = [
    snapshot.yesAsk !== null ? { side: "yes" as const, ask: snapshot.yesAsk, snapshot } : null,
    snapshot.noAsk !== null ? { side: "no" as const, ask: snapshot.noAsk, snapshot } : null,
  ].filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null);
  const inBand = candidates.filter(candidate => candidate.ask >= floor && candidate.ask <= ceiling);
  if (inBand.length === 1) return inBand[0]!;
  // Two expensive opposite asks indicate an ambiguous/wide book, not a clear
  // market direction. Never guess a side for execution.
  if (inBand.length > 1) return allowNearest
    ? [...inBand].sort((a, b) => b.ask - a.ask)[0]!
    : null;
  if (!allowNearest || candidates.length === 0) return null;
  return candidates.sort((a, b) =>
    distanceFromBand(a.ask, floor, ceiling) - distanceFromBand(b.ask, floor, ceiling)
  )[0]!;
}