import type { KalshiSide } from "./kalshi-orderbook-store.ts";

/**
 * Narrow Bot 1 adapter over Dashboard 2's authenticated book.  It deliberately
 * receives its ticker, already-selected side, and requested count from Bot 1;
 * this module cannot choose a strategy, direction, or size.
 */
export interface AuthenticatedBookExecutionQuote {
  readonly ticker: string;
  readonly side: KalshiSide;
  readonly requestedCount: number;
  /** Kalshi CreateOrder's YES-price limit on the cent grid. */
  readonly limitPrice: number;
  /** Maximum cash consumed if every requested contract fills at the limit. */
  readonly worstCaseCost: number;
  readonly bookVersion: string;
  readonly marginalLimitCost: number;
  readonly revalidate: () => boolean;
}

export interface AuthenticatedBookReader {
  getExecutable: (
    ticker: string,
    side: KalshiSide,
    maxContracts: number,
    floor: number,
    ceiling: number,
  ) => {
    ticker: string;
    side: KalshiSide;
    marginalLimitCost: number;
    bestExecutableCost: number;
    visibleContracts: number;
    bookVersion: string;
  } | null;
  isFresh: (ticker: string) => boolean;
}

export function quoteAuthenticatedBookExecution(
  input: Readonly<{
    ticker: string;
    side: KalshiSide;
    requestedCount: number;
    sideCostFloor: number;
    sideCostCeiling: number;
  }>,
  service: AuthenticatedBookReader,
): AuthenticatedBookExecutionQuote | null {
  if (
    !input.ticker
    || !Number.isInteger(input.requestedCount)
    || input.requestedCount < 1
    || !Number.isFinite(input.sideCostFloor)
    || !Number.isFinite(input.sideCostCeiling)
    || input.sideCostFloor < 0
    || input.sideCostCeiling > 1
    || input.sideCostFloor > input.sideCostCeiling
  ) return null;
  // A full requested-depth quote only. getExecutable may otherwise return a
  // smaller visible quantity, which must never authorize a Bot 1 submission.
  // Read from zero rather than filtering away favorable levels. A marketable
  // IOC cannot impose a minimum fill cost: Kalshi may price-improve into any
  // cheaper resting level. Therefore a cheaper visible level must invalidate
  // the whole quote instead of being hidden by the reader's floor filter.
  const quote = service.getExecutable(
    input.ticker,
    input.side,
    input.requestedCount,
    0,
    input.sideCostCeiling,
  );
  if (
    !quote
    || !service.isFresh(input.ticker)
    || quote.ticker !== input.ticker
    || quote.side !== input.side
    || quote.visibleContracts < input.requestedCount
    || !Number.isFinite(quote.bestExecutableCost)
    || quote.bestExecutableCost + Number.EPSILON < input.sideCostFloor
    || quote.marginalLimitCost < input.sideCostFloor
    || quote.marginalLimitCost > input.sideCostCeiling
  ) return null;

  // marginalLimitCost is a side cost. Kalshi's order API accepts a YES price:
  // buying NO therefore converts the conservative side ceiling back to YES.
  const sideCeilingCents = Math.ceil((quote.marginalLimitCost - Number.EPSILON) * 100);
  if (!Number.isInteger(sideCeilingCents) || sideCeilingCents < 0 || sideCeilingCents > 100) return null;
  const limitPrice = input.side === "yes"
    ? sideCeilingCents / 100
    : (100 - sideCeilingCents) / 100;
  const worstCaseCost = (sideCeilingCents * input.requestedCount) / 100;
  const immutableVersion = quote.bookVersion;
  const immutableMarginalCost = quote.marginalLimitCost;

  return Object.freeze({
    ticker: input.ticker,
    side: input.side,
    requestedCount: input.requestedCount,
    limitPrice,
    worstCaseCost,
    bookVersion: immutableVersion,
    marginalLimitCost: immutableMarginalCost,
    revalidate: () => {
      if (!service.isFresh(input.ticker)) return false;
      const current = service.getExecutable(
        input.ticker,
        input.side,
        input.requestedCount,
        0,
        input.sideCostCeiling,
      );
      return Boolean(
        current
        && current.ticker === input.ticker
        && current.side === input.side
        && current.visibleContracts >= input.requestedCount
        && Number.isFinite(current.bestExecutableCost)
        && current.bestExecutableCost + Number.EPSILON >= input.sideCostFloor
        && current.marginalLimitCost >= input.sideCostFloor
        && current.marginalLimitCost <= input.sideCostCeiling
        && current.bookVersion === immutableVersion
        && current.marginalLimitCost === immutableMarginalCost,
      );
    },
  });
}