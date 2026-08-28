export interface Dashboard2ConvictionSnapshot {
  yesAsk: number | null;
  yesBid: number | null;
  noAsk: number | null;
  fetchedAt: number;
  ticker: string | undefined;
  target: number | null;
}

function distanceFromBand(cost: number, floor: number, ceiling: number): number {
  return cost < floor ? floor - cost : cost > ceiling ? cost - ceiling : 0;
}

export function selectDashboard2ConvictionSideFromSnapshot(
  snapshot: Dashboard2ConvictionSnapshot | null,
  ticker: string,
  floor: number,
  ceiling: number,
  allowNearest = false,
): { side: "yes" | "no"; ask: number; snapshot: Dashboard2ConvictionSnapshot } | null {
  if (!snapshot || snapshot.ticker !== ticker) return null;
  const noAsk = snapshot.noAsk ?? (snapshot.yesBid !== null ? 1 - snapshot.yesBid : null);
  const candidates = [
    snapshot.yesAsk !== null ? { side: "yes" as const, ask: snapshot.yesAsk, snapshot } : null,
    noAsk !== null ? { side: "no" as const, ask: noAsk, snapshot } : null,
  ].filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null);
  const inBand = candidates.filter(candidate => candidate.ask >= floor && candidate.ask <= ceiling);
  // Match Bot 1 conviction semantics: YES has deterministic precedence when
  // the source reports both sides inside the configured zone.
  if (inBand.length > 0) return inBand[0]!;
  if (!allowNearest || candidates.length === 0) return null;
  return candidates.sort((a, b) =>
    distanceFromBand(a.ask, floor, ceiling) - distanceFromBand(b.ask, floor, ceiling)
  )[0]!;
}