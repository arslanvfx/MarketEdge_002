/**
 * Narrow owner boundary for Smart Exit.
 *
 * Smart Exit may ask an owner to close an exact immutable snapshot. It never
 * edits either owner's registry directly. The regular adapter revalidates the
 * full identity immediately before delegating to the canonical durable close
 * lifecycle. Scalper early-close ownership does not exist yet, so it fails
 * closed rather than reusing entry or settlement mechanics.
 */
import { openPositions, type OpenPosition } from "./kalshi-bot-state.ts";
import { closePosition } from "./kalshi-bot-close.ts";
import { fetchOrderbookPrices, getKalshiCachedData } from "./crypto-kalshi.ts";
import type { SmartExitPosition } from "./kalshi-smart-exit-types.ts";
import {
  computeSmartExitExecutionLimit,
  smartExitIdentityMatches,
} from "./kalshi-smart-exit-execution.ts";

export type SmartExitOwnerCloseResult =
  | { outcome: "filled"; reason: string }
  | { outcome: "blocked"; reason: string }
  | { outcome: "unknown"; reason: string };

function regularIdentityMatches(
  current: OpenPosition | undefined,
  expected: SmartExitPosition,
): current is OpenPosition {
  return current != null && smartExitIdentityMatches({
    positionId: current.id,
    symbol: current.symbol,
    windowKey: current.windowKey,
    ticker: current.ticker,
    side: current.direction,
    tradingMode: current.entryMode,
    remainingQuantity: current.contractCount,
  }, expected);
}

export async function requestSmartExitFromOwner(params: {
  position: SmartExitPosition;
  parameterVersion: string;
  executionConstraint: {
    minimumWinningPrice: number;
    evaluatedBookObservedAtSeconds: number;
    maximumEvidenceAgeSeconds: number;
    evidenceExpiresAtSeconds: number;
  };
  isVersionStillAuthorized: (
    position: SmartExitPosition,
    parameterVersion: string,
  ) => boolean;
}): Promise<SmartExitOwnerCloseResult> {
  const { position, parameterVersion } = params;
  const constraint = params.executionConstraint;
  if (position.owner.kind === "scalper") {
    return {
      outcome: "blocked",
      reason: "scalper early-close lifecycle unavailable; position left untouched",
    };
  }

  const symbol = position.symbol.toUpperCase();
  const current = openPositions.get(symbol);
  if (!regularIdentityMatches(current, position)) {
    return { outcome: "blocked", reason: "regular position identity changed" };
  }
  if (!params.isVersionStillAuthorized(position, parameterVersion)) {
    return { outcome: "blocked", reason: "parameter version is no longer authorized" };
  }
  const nowSeconds = Date.now() / 1_000;
  if (
    !Number.isFinite(constraint.minimumWinningPrice)
    || constraint.minimumWinningPrice <= 0
    || constraint.minimumWinningPrice >= 1
    || !Number.isFinite(constraint.evaluatedBookObservedAtSeconds)
    || !Number.isFinite(constraint.evidenceExpiresAtSeconds)
    || nowSeconds > constraint.evidenceExpiresAtSeconds
    || constraint.evaluatedBookObservedAtSeconds > nowSeconds
  ) {
    return { outcome: "blocked", reason: "evaluated economic constraint is stale or invalid" };
  }

  const market = getKalshiCachedData(symbol);
  if (
    !market
    || market.ticker !== position.ticker
    || market.value !== position.strikePrice
    || market.yesPrice == null
  ) {
    return { outcome: "blocked", reason: "fresh exact regular market identity or quote unavailable" };
  }
  if (
    market.at == null
    || nowSeconds - market.at / 1_000 > constraint.maximumEvidenceAgeSeconds
    || market.at / 1_000 > nowSeconds
  ) {
    return { outcome: "blocked", reason: "fresh exact regular market quote is stale" };
  }

  const freshBook = await fetchOrderbookPrices(position.ticker);
  if (!freshBook) {
    return { outcome: "blocked", reason: "fresh authenticated exit book unavailable" };
  }
  const executionLimit = computeSmartExitExecutionLimit({
    side: position.side,
    quantity: position.remainingQuantity,
    minimumWinningPrice: constraint.minimumWinningPrice,
    yesDepth: freshBook.yesDepth,
    noDepth: freshBook.noDepth,
  });
  if (!executionLimit.allowed || executionLimit.yesSideLimitPrice == null) {
    return { outcome: "blocked", reason: "fresh exit book no longer covers quantity at economic floor" };
  }
  const yesSideLimitPrice = executionLimit.yesSideLimitPrice;

  try {
    const finalGuard = () => {
      if (!params.isVersionStillAuthorized(position, parameterVersion)) return false;
      if (!regularIdentityMatches(openPositions.get(symbol), position)) return false;
      if (Date.now() / 1_000 > constraint.evidenceExpiresAtSeconds) return false;
      const latestMarket = getKalshiCachedData(symbol);
      return latestMarket?.ticker === position.ticker
        && latestMarket.value === position.strikePrice
        && latestMarket.yesPrice != null
        && latestMarket.at != null
        && Date.now() - latestMarket.at <= constraint.maximumEvidenceAgeSeconds * 1_000;
    };
    await closePosition(
      current,
      market.yesPrice,
      market.value,
      `smart_exit:${parameterVersion}`,
      false,
      {
        preSubmitGuard: finalGuard,
        smartExitLimit: {
          yesSideLimitPrice,
          minimumWinningPrice: constraint.minimumWinningPrice,
        },
      },
    );
  } catch (error) {
    const message = String((error as Error)?.message ?? error);
    if (message.includes("owner pre-submit authorization revoked")) {
      return { outcome: "blocked", reason: "final owner identity or authorization changed before submit" };
    }
    return {
      outcome: "unknown",
      reason: `owner close did not confirm completion: ${message.slice(0, 180)}`,
    };
  }

  const after = openPositions.get(symbol);
  if (after?.id === current.id) {
    // Registry ownership remains with the regular adapter. Delete only the
    // exact object whose canonical close completed.
    openPositions.delete(symbol);
  } else if (after != null) {
    return { outcome: "unknown", reason: "position registry changed after confirmed owner close" };
  }
  return { outcome: "filled", reason: "canonical regular close completed" };
}