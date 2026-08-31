export interface KalshiMarketCandidate {
  close_time?: string;
  floor_strike?: number | string;
}

const MAX_CLOSE_TIME_DRIFT_MS = 8 * 60_000;

export function parseKalshiFloorStrike(
  value: number | string | undefined,
): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Commodity contracts compare the candle at contract close with the one-minute
 * candle closing at the traded window's open. fetchPythWindowClosePrice accepts
 * a 15-minute window start, so the reference window starts 30 minutes before
 * the selected market closes.
 */
export function commodityOpeningReferenceWindowKey(
  marketCloseTime: Date,
): string | null {
  const closeMs = marketCloseTime.getTime();
  if (!Number.isFinite(closeMs)) return null;
  return new Date(closeMs - 30 * 60_000).toISOString().slice(0, 16);
}

export function selectKalshiMarket<T extends KalshiMarketCandidate>(
  markets: readonly T[],
  targetTime?: Date,
): T | undefined {
  if (!targetTime) return markets[0];

  const targetMs = targetTime.getTime();
  const withCloseTime = markets.filter((market) => market.close_time);
  if (withCloseTime.length === 0) return markets[0];

  let selected: T | undefined;
  let bestDiff = Infinity;
  for (const market of withCloseTime) {
    const closeMs = new Date(market.close_time!).getTime();
    if (!Number.isFinite(closeMs)) continue;
    const diff = Math.abs(closeMs - targetMs);
    if (diff < MAX_CLOSE_TIME_DRIFT_MS && diff < bestDiff) {
      selected = market;
      bestDiff = diff;
    }
  }
  return selected;
}