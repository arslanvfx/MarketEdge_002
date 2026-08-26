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
import { getKalshiCachedData } from "./crypto-kalshi.ts";
import type { SmartExitPosition } from "./kalshi-smart-exit-types.ts";
import { smartExitIdentityMatches } from "./kalshi-smart-exit-execution.ts";

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
  isVersionStillAuthorized: (
    position: SmartExitPosition,
    parameterVersion: string,
  ) => boolean;
}): Promise<SmartExitOwnerCloseResult> {
  const { position, parameterVersion } = params;
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

  const market = getKalshiCachedData(symbol);
  if (
    !market
    || market.ticker !== position.ticker
    || market.value !== position.strikePrice
    || market.yesPrice == null
  ) {
    return { outcome: "blocked", reason: "fresh exact regular market identity or quote unavailable" };
  }

  try {
    const finalGuard = () => {
      if (!params.isVersionStillAuthorized(position, parameterVersion)) return false;
      if (!regularIdentityMatches(openPositions.get(symbol), position)) return false;
      const latestMarket = getKalshiCachedData(symbol);
      return latestMarket?.ticker === position.ticker
        && latestMarket.value === position.strikePrice
        && latestMarket.yesPrice != null;
    };
    await closePosition(
      current,
      market.yesPrice,
      market.value,
      `smart_exit:${parameterVersion}`,
      false,
      { preSubmitGuard: finalGuard },
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