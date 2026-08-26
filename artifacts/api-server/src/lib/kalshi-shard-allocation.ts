export interface KalshiRouteBalance {
  exchangeIndex: number;
  availableBalance: number;
}

export interface KalshiRouteFundingTarget {
  exchangeIndex: number;
  targetAvailableBalance: number;
}

export interface KalshiRouteTransferPlan {
  sourceExchangeIndex: number;
  destinationExchangeIndex: number;
  amountCenticents: number;
}

export interface ScalperFundingCandidate {
  symbol: string;
  exchangeIndex: number;
  requiredBalance: number;
}

export interface ScalperRouteFundingPlan {
  fundedSymbols: Set<string>;
  blockedSymbols: Set<string>;
  targets: KalshiRouteFundingTarget[];
}

export function applyVerifiedFundingSnapshot<T>(
  existing: Map<string, T>,
  ownedKeys: readonly string[],
  verifiedSnapshot: ReadonlyMap<string, T> | null,
): void {
  // A failed or deadline-skipped refresh is not evidence that the prior
  // current-window verification became invalid.
  if (verifiedSnapshot == null) return;
  for (const key of ownedKeys) existing.delete(key);
  for (const [key, value] of verifiedSnapshot) existing.set(key, value);
}

export function hasCompleteKalshiRouteBalances(
  breakdown: readonly KalshiRouteBalance[] | null | undefined,
  targets: readonly KalshiRouteFundingTarget[],
): boolean {
  if (!breakdown || breakdown.length === 0 || targets.length === 0) return false;
  if (breakdown.some((entry) =>
    !Number.isInteger(entry.exchangeIndex)
    || entry.exchangeIndex < 0
    || !Number.isFinite(entry.availableBalance)
    || entry.availableBalance < 0
  )) {
    return false;
  }
  const observedRoutes = new Set(breakdown.map((entry) => entry.exchangeIndex));
  return targets.every((target) => observedRoutes.has(target.exchangeIndex));
}

const toCenticents = (dollars: number): number =>
  Math.max(0, Math.floor(dollars * 10_000 + 1e-6));

/**
 * Assigns whole configured attempts without overcommitting aggregate cash.
 * Routes take turns so a large crypto registry cannot starve a smaller
 * commodity route before either route receives one executable opportunity.
 */
export function planScalperRouteFunding(
  aggregateAvailableBalance: number,
  candidates: readonly ScalperFundingCandidate[],
): ScalperRouteFundingPlan {
  const availableCenticents = toCenticents(aggregateAvailableBalance);
  const byRoute = new Map<number, ScalperFundingCandidate[]>();
  for (const candidate of candidates) {
    if (
      !candidate.symbol
      || !Number.isInteger(candidate.exchangeIndex)
      || candidate.exchangeIndex < 0
      || !Number.isFinite(candidate.requiredBalance)
      || candidate.requiredBalance <= 0
    ) {
      continue;
    }
    const route = byRoute.get(candidate.exchangeIndex) ?? [];
    route.push(candidate);
    byRoute.set(candidate.exchangeIndex, route);
  }
  for (const route of byRoute.values()) {
    route.sort((a, b) => a.symbol.localeCompare(b.symbol));
  }

  const routeIndexes = [...byRoute.keys()].sort((a, b) => a - b);
  const fundedSymbols = new Set<string>();
  const targetCenticents = new Map<number, number>();
  let remainingCenticents = availableCenticents;
  const maxDepth = Math.max(0, ...[...byRoute.values()].map((route) => route.length));

  for (let depth = 0; depth < maxDepth; depth += 1) {
    for (const exchangeIndex of routeIndexes) {
      const candidate = byRoute.get(exchangeIndex)?.[depth];
      if (!candidate) continue;
      const requiredCenticents = toCenticents(candidate.requiredBalance);
      if (requiredCenticents <= 0 || requiredCenticents > remainingCenticents) continue;
      fundedSymbols.add(candidate.symbol);
      targetCenticents.set(
        exchangeIndex,
        (targetCenticents.get(exchangeIndex) ?? 0) + requiredCenticents,
      );
      remainingCenticents -= requiredCenticents;
    }
  }

  const blockedSymbols = new Set(
    candidates
      .map((candidate) => candidate.symbol)
      .filter((symbol) => !fundedSymbols.has(symbol)),
  );
  return {
    fundedSymbols,
    blockedSymbols,
    targets: [...targetCenticents.entries()].map(
      ([exchangeIndex, amountCenticents]) => ({
        exchangeIndex,
        targetAvailableBalance: amountCenticents / 10_000,
      }),
    ),
  };
}

/**
 * Moves only route surplus above its own target. This is the key difference
 * from independently funding several destinations, where a later transfer can
 * undo an earlier route's reserve.
 */
export function planKalshiRouteTransfers(
  aggregateAvailableBalance: number,
  breakdown: readonly KalshiRouteBalance[],
  targets: readonly KalshiRouteFundingTarget[],
): KalshiRouteTransferPlan[] {
  const aggregateCenticents = toCenticents(aggregateAvailableBalance);
  const desired = new Map<number, number>();
  for (const target of targets) {
    if (
      !Number.isInteger(target.exchangeIndex)
      || target.exchangeIndex < 0
      || !Number.isFinite(target.targetAvailableBalance)
      || target.targetAvailableBalance < 0
    ) {
      throw new Error("Kalshi route funding target is invalid");
    }
    desired.set(
      target.exchangeIndex,
      toCenticents(target.targetAvailableBalance),
    );
  }
  const desiredTotal = [...desired.values()].reduce((sum, value) => sum + value, 0);
  if (desiredTotal > aggregateCenticents) {
    throw new Error("Kalshi route funding targets exceed aggregate available cash");
  }

  const current = new Map<number, number>();
  for (const entry of breakdown) {
    if (
      !Number.isInteger(entry.exchangeIndex)
      || entry.exchangeIndex < 0
      || !Number.isFinite(entry.availableBalance)
      || entry.availableBalance < 0
    ) continue;
    current.set(
      entry.exchangeIndex,
      (current.get(entry.exchangeIndex) ?? 0) + toCenticents(entry.availableBalance),
    );
  }

  const deficits = [...desired.entries()]
    .map(([exchangeIndex, amount]) => ({
      exchangeIndex,
      amount: Math.max(0, amount - (current.get(exchangeIndex) ?? 0)),
    }))
    .filter((entry) => entry.amount > 0)
    .sort((a, b) => a.exchangeIndex - b.exchangeIndex);
  const sources = [...current.entries()]
    .map(([exchangeIndex, amount]) => ({
      exchangeIndex,
      amount: Math.max(0, amount - (desired.get(exchangeIndex) ?? 0)),
    }))
    .filter((entry) => entry.amount > 0)
    .sort((a, b) => b.amount - a.amount || a.exchangeIndex - b.exchangeIndex);

  const transfers: KalshiRouteTransferPlan[] = [];
  for (const deficit of deficits) {
    for (const source of sources) {
      if (deficit.amount <= 0) break;
      if (source.amount <= 0 || source.exchangeIndex === deficit.exchangeIndex) continue;
      const amountCenticents = Math.min(source.amount, deficit.amount);
      transfers.push({
        sourceExchangeIndex: source.exchangeIndex,
        destinationExchangeIndex: deficit.exchangeIndex,
        amountCenticents,
      });
      source.amount -= amountCenticents;
      deficit.amount -= amountCenticents;
    }
    if (deficit.amount > 0) {
      throw new Error("Kalshi route balances cannot fund the planned allocation");
    }
  }
  return transfers;
}